/*
 * Booking a new membership's first visit on the server, from the Stripe
 * payment (2026-11-03).
 *
 * The customer describes the job, picks a held time and only then pays for a
 * membership (utils/membershipFirstVisit.js). Everything they entered - the
 * job, the home, the photos, the time and the hold - is saved here as a
 * MembershipFirstVisitDraft BEFORE the Stripe page opens, and the page is
 * linked to it. When Stripe confirms the payment, the webhook books exactly one
 * visit from the draft, awaiting the owner's approval like every member visit.
 * The customer does not have to come back to the website for that: the
 * success page only shows what the server made (and can ask it to finish a
 * paid draft, after checking the payment with Stripe).
 *
 * EXACTLY ONCE. A draft moves paid -> fulfilling with one atomic update, so
 * webhook retries, duplicate events, the success page and the sweep cannot
 * book twice; a booking already made from the draft (firstVisitDraftId) is
 * found before anything is created, so a crash between the two is safe too. A
 * claim left "fulfilling" for ten minutes is taken over by the sweep.
 *
 * NEVER SILENTLY UNBOOKED. If the time is gone (the hold lapsed while Stripe
 * was slow and someone else booked it), the member lead time applies (no
 * exemption: they already had a membership), or booking keeps failing, the
 * draft becomes needs_admin: an Admin activity entry and an email to the owner
 * say what happened and what to do, the customer is emailed that their
 * membership is active and asked to pick another time, and the exemption is
 * left unspent so that time can be soon. A customer who then books it
 * themselves closes the draft (rebooked).
 *
 * Existing bookings and subscriptions are never changed here.
 */
const Booking = require("../models/Booking");
const User = require("../models/User");
const Subscription = require("../models/Subscription");
const AdminActivityLog = require("../models/AdminActivityLog");
const Draft = require("../models/MembershipFirstVisitDraft");
const mail = require("./emailService");
const smsNotify = require("./sms/smsNotifications");
const generalFixterNotify = require("./generalFixterNotify");
const adminSubjects = require("./adminSubjects");
const { isBeforeEarliestMemberVisit, earliestMemberVisitYMD } = require("./bookingLeadTime");
const {
  firstVisitExemptionActive,
  claimFirstVisitExemption,
  releaseFirstVisitExemption,
  attachFirstVisitBooking,
} = require("./membershipFirstVisit");

const TZ = "America/New_York";
const STALE_FULFILLING_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const CLIENT_URL = String(process.env.CLIENT_URL || "https://www.profixter.com").replace(/\/+$/, "");

/* Loaded on use: slotReservationService requires models this module also loads, and the webhook requires both. */
const reservations = () => require("./slotReservationService");
const subscriptionAccess = () => require("./subscriptionManagement");

function log(level, event, fields = {}) {
  const line = JSON.stringify({ event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}

/* ------------------------------------------------------------- drafts */

async function createFirstVisitDraft({ user, addressId, service, note, images = [], s3Keys = [], requestedDate, requestedTime, slotStart, holdToken = "" }) {
  return Draft.create({
    user: user._id,
    userId: String(user.userId || ""),
    addressId,
    service: String(service || "").slice(0, 120),
    note: String(note || "").slice(0, 1200),
    images,
    s3Keys,
    requestedDate,
    requestedTime,
    slotStart,
    holdId: String(holdToken || "").split(".")[0] || "",
    status: "draft",
  });
}

/** The draft the checkout is for: the customer's own, for this home and this time, not yet paid. */
async function draftForCheckout({ draftId, userId, addressId, requestedDate, requestedTime }) {
  if (!draftId) return null;
  const draft = await Draft.findOne({ _id: draftId, user: userId, status: { $in: ["draft", "checkout_open"] } });
  if (!draft) return null;
  if (String(draft.addressId) !== String(addressId) || draft.requestedDate !== requestedDate || draft.requestedTime !== requestedTime) return null;
  return draft;
}

async function attachDraftToCheckout(draft, { checkoutSessionId, holdToken = "" }) {
  const holdId = String(holdToken || "").split(".")[0];
  await Draft.updateOne(
    { _id: draft._id, status: { $in: ["draft", "checkout_open"] } },
    { $set: { status: "checkout_open", checkoutSessionId, ...(holdId ? { holdId } : {}) } }
  );
}

function draftIdFromSession(session) {
  return String(session?.metadata?.firstVisitDraftId || "") || null;
}

/** Stripe says this checkout is paid: the draft can be booked. Idempotent. */
async function markFirstVisitPaid(session, subscription) {
  const draftId = draftIdFromSession(session);
  if (!draftId) return null;
  const now = new Date();
  await Draft.updateOne(
    { _id: draftId, checkoutSessionId: session.id, status: { $in: ["draft", "checkout_open"] } },
    { $set: { status: "paid", paidAt: now, ...(subscription?._id ? { subscriptionId: subscription._id } : {}) } }
  );
  if (subscription?._id) await Draft.updateOne({ _id: draftId, subscriptionId: null }, { $set: { subscriptionId: subscription._id } });
  return Draft.findById(draftId);
}

/** The page lapsed unpaid: nothing to book, and the photos it carried are deleted. */
async function markFirstVisitExpired(session) {
  const draftId = draftIdFromSession(session);
  if (!draftId) return;
  const draft = await Draft.findOneAndUpdate(
    { _id: draftId, checkoutSessionId: session.id, status: { $in: ["draft", "checkout_open"] } },
    { $set: { status: "expired" } },
    { new: true }
  );
  if (draft?.s3Keys?.length && process.env.S3_BUCKET) {
    // Loaded here: utils/s3 refuses to load without S3_BUCKET, and most callers never delete photos.
    const { deletePublicObjects } = require("./s3");
    await deletePublicObjects({ Bucket: process.env.S3_BUCKET, Keys: draft.s3Keys }).catch((error) =>
      log("error", "first_visit_draft_photo_cleanup_failed", { draftId, error: String(error?.message || error).slice(0, 160) })
    );
  }
}

/* ------------------------------------------------------------ booking */

function addressLineOf(home) {
  return [home?.line1, home?.city, home?.state, home?.zip].filter(Boolean).join(", ");
}

/* The same messages a member booking made on the website sends (routes/bookings.js POST /). */
async function sendBookingNotices({ booking, user, home }) {
  const addressLine = addressLineOf(home);
  const nyTime = new Date(booking.date).toLocaleString("en-US", { timeZone: TZ, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });
  try {
    if (user.email) {
      await mail.sendTx(
        "booking_created",
        user.email,
        { name: user.name || user.email.split("@")[0], bookingNumber: booking.bookingNumber, date: booking.date, service: booking.service, address: addressLine },
        { bccAdmin: false, logContext: { bookingId: booking._id, bookingNumber: booking.bookingNumber, customerName: user.name || "", customerEmail: user.email, recipientName: user.name || "", recipientEmail: user.email, emailType: "transactional", source: "membershipFirstVisit" } }
      );
    }
    await mail.sendPromo(process.env.MAIL_ADMIN || "getfixter@gmail.com", {
      subject: adminSubjects.booking("New Booking", { name: user.name, date: booking.date }),
      html: `
        <h2>New Booking Created</h2>
        <p>The first visit of a new membership: booked before paying, and booked automatically once Stripe confirmed the payment. It awaits your approval like every member visit.</p>
        <ul>
          <li><strong>Name:</strong> ${user.name || ""}</li>
          <li><strong>Email:</strong> ${user.email || ""}</li>
          <li><strong>Phone:</strong> ${user.phone || "-"}</li>
          <li><strong>Service:</strong> ${booking.service}</li>
          <li><strong>Date:</strong> ${nyTime}</li>
          <li><strong>Address:</strong> ${addressLine}</li>
          <li><strong>Booking #:</strong> ${booking.bookingNumber}</li>
          <li><strong>Customer photos:</strong> ${(booking.images || []).length || "Not added yet"}</li>
        </ul>`,
      logContext: { templateKey: "admin_booking_created", bookingId: booking._id, bookingNumber: booking.bookingNumber, customerName: user.name || "", customerEmail: user.email || "", recipientEmail: process.env.MAIL_ADMIN || "getfixter@gmail.com", emailType: "admin", source: "membershipFirstVisit" },
    });
  } catch (error) {
    log("error", "first_visit_booking_mail_failed", { bookingId: String(booking._id), error: String(error?.message || error).slice(0, 160) });
  }
  // Never throws (utils/sms/smsNotifications): eligibility, consent and STOP decide whether it is sent.
  await smsNotify.notifyBookingConfirmed(booking, user, "membershipFirstVisit");
  try {
    await generalFixterNotify.bookingCreated(mail, {
      bookingId: booking._id,
      bookingNumber: booking.bookingNumber,
      customerName: user.name || "",
      customerEmail: user.email || "",
      phone: user.phone || "",
      date: booking.date,
      service: booking.service,
      bookingType: "Membership visit",
      address: addressLine,
      note: booking.note || "",
      source: "membershipFirstVisit",
    });
  } catch (error) {
    log("error", "first_visit_crew_notice_failed", { bookingId: String(booking._id), error: String(error?.message || error).slice(0, 160) });
  }
}

/* Admin must act: recorded where Admin looks (activity log), the owner emailed, the customer told what to do. Once per draft. */
async function needsAdmin(draft, reason, { user, home }) {
  const fresh = await Draft.findOneAndUpdate(
    { _id: draft._id, status: "fulfilling" },
    { $set: { status: "needs_admin", failureReason: reason, adminNotifiedAt: new Date() } },
    { new: true }
  );
  if (!fresh) return Draft.findById(draft._id);
  const when = new Date(draft.slotStart).toLocaleString("en-US", { timeZone: TZ, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
  const why = {
    slot_unavailable: "the time they chose was taken before the payment came through",
    member_lead_time: "they already had a membership, so this visit follows the member seven-day rule",
    no_active_membership: "the membership was paid but is not active yet",
    booking_failed: "booking it failed repeatedly",
  }[reason] || reason;
  await AdminActivityLog.create({
    action: "first_visit_needs_admin",
    entityType: "customer",
    entityId: String(draft.user),
    entityName: user?.name || user?.email || "",
    actorName: "System (Stripe payment)",
    actorRole: "system",
    details: {
      draftId: String(draft._id),
      reason,
      requested: `${draft.requestedDate} ${draft.requestedTime}`,
      service: draft.service,
      address: addressLineOf(home),
      checkoutSessionId: draft.checkoutSessionId,
      action: "Call the customer to book their first visit (any open time; not held to the member seven days unless the reason says so).",
    },
  }).catch((error) => log("error", "first_visit_activity_log_failed", { draftId: String(draft._id), error: String(error?.message || error).slice(0, 160) }));
  try {
    await mail.sendPromo(process.env.MAIL_ADMIN || "getfixter@gmail.com", {
      subject: `Action needed: first visit not booked - ${user?.name || user?.email || "customer"}`,
      html: `
        <h2>A paid membership's first visit could not be booked</h2>
        <p>The membership is active and paid. The first visit was not booked because ${why}.</p>
        <ul>
          <li><strong>Customer:</strong> ${user?.name || ""} (${user?.email || ""}, ${user?.phone || "-"})</li>
          <li><strong>Asked for:</strong> ${when}</li>
          <li><strong>Job:</strong> ${draft.service || draft.note || "-"}</li>
          <li><strong>Address:</strong> ${addressLineOf(home)}</li>
        </ul>
        <p>Please call them to book it. They have also been emailed to pick another time on the website; if they do, this is closed automatically.</p>`,
      logContext: { templateKey: "admin_first_visit_needs_admin", customerName: user?.name || "", customerEmail: user?.email || "", recipientEmail: process.env.MAIL_ADMIN || "getfixter@gmail.com", emailType: "admin", source: "membershipFirstVisit" },
    });
  } catch (error) {
    log("error", "first_visit_admin_mail_failed", { draftId: String(draft._id), error: String(error?.message || error).slice(0, 160) });
  }
  if (user?.email) {
    try {
      await mail.sendRaw({
        to: user.email,
        subject: "Your Profixter membership is active - let's pick your visit time",
        text: [
          `Hi ${String(user.name || "").split(" ")[0] || "there"},`,
          "",
          "Thank you - your Profixter membership is active.",
          reason === "member_lead_time"
            ? `We couldn't book your visit for ${when}: member visits are booked at least 7 days ahead.`
            : `We couldn't book your visit for ${when}, because that time was just taken.`,
          "",
          `Please pick another time here: ${CLIENT_URL}/book/handyman`,
          "Or reply to this email, or call us at 631-599-1363, and we'll book it for you.",
          "",
          "Profixter",
        ].join("\n"),
        logContext: { templateKey: "first_visit_pick_another_time", customerName: user.name || "", customerEmail: user.email, recipientEmail: user.email, emailType: "transactional", source: "membershipFirstVisit" },
      });
    } catch (error) {
      log("error", "first_visit_customer_mail_failed", { draftId: String(draft._id), error: String(error?.message || error).slice(0, 160) });
    }
  }
  log("info", "first_visit_needs_admin", { draftId: String(draft._id), reason });
  return fresh;
}

/**
 * Book the visit from a paid draft. Safe to call any number of times, from
 * anywhere (webhook, success page, sweep): only one caller ever books.
 * Returns the draft as it stands afterwards.
 */
async function fulfillFirstVisitDraft(draftId, { now = new Date() } = {}) {
  const claimed = await Draft.findOneAndUpdate(
    {
      _id: draftId,
      $or: [{ status: "paid" }, { status: "fulfilling", fulfillingAt: { $lt: new Date(now.getTime() - STALE_FULFILLING_MS) } }],
    },
    { $set: { status: "fulfilling", fulfillingAt: now }, $inc: { attempts: 1 } },
    { new: true }
  );
  if (!claimed) return Draft.findById(draftId);
  const draft = claimed;

  // Already booked (a crash after the booking, before the draft was marked): finish the record only.
  const made = await Booking.findOne({ firstVisitDraftId: draft._id }).select("_id").lean();
  if (made) {
    return Draft.findOneAndUpdate({ _id: draft._id }, { $set: { status: "booked", bookingId: made._id, bookedAt: now } }, { new: true });
  }

  const user = await User.findById(draft.user);
  const home = user?.addresses?.id?.(draft.addressId) || null;
  let exemptionClaimed = null;
  try {
    if (!user || !home) return needsAdmin(draft, "booking_failed", { user, home });

    const subscription =
      (draft.subscriptionId && (await Subscription.findById(draft.subscriptionId))) ||
      (await Subscription.findOne({ user: user._id, addressId: home._id, status: { $in: ["active", "trialing"] } }).sort({ updatedAt: -1 }));
    if (!subscription || !subscriptionAccess().subscriptionGrantsAccess(subscription)) {
      // The membership sync may still be on its way: try again later, then hand it to Admin.
      if (draft.attempts >= MAX_ATTEMPTS) return needsAdmin(draft, "no_active_membership", { user, home });
      return Draft.findOneAndUpdate({ _id: draft._id, status: "fulfilling" }, { $set: { status: "paid" } }, { new: true });
    }

    // The customer already booked this membership's first visit themselves (with the exemption): nothing to add.
    if (subscription.firstVisitExemption?.bookingId) {
      return Draft.findOneAndUpdate({ _id: draft._id }, { $set: { status: "rebooked", bookingId: subscription.firstVisitExemption.bookingId, subscriptionId: subscription._id } }, { new: true });
    }

    if (firstVisitExemptionActive(subscription, now)) {
      if (await claimFirstVisitExemption(subscription._id, now)) exemptionClaimed = subscription._id;
    } else if (isBeforeEarliestMemberVisit(draft.requestedDate)) {
      return needsAdmin(draft, "member_lead_time", { user, home });
    }

    const bookingData = {
      bookingNumber: Math.floor(10000000 + Math.random() * 90000000).toString(),
      date: draft.slotStart,
      service: draft.service || "Handyman visit",
      user: user._id,
      userId: user.userId,
      name: user.name,
      phone: user.phone,
      email: user.email,
      addressId: home._id,
      address: home.line1 || "",
      city: home.city || "",
      state: home.state || "",
      zip: home.zip || "",
      county: home.county || "",
      subscription: subscription.subscriptionType,
      accessType: "membership",
      bookingType: "membership_visit",
      paymentState: "not_required",
      isFreeFirstVisit: false,
      note: draft.note || draft.service || "",
      images: draft.images || [],
      status: "Pending",
      firstVisitDraftId: draft._id,
    };

    let booking;
    const engine = reservations();
    if (engine.reservationEngineEnabled()) {
      // Their own hold gives way to the booking, exactly as on the website.
      if (draft.holdId && draft.checkoutSessionId) {
        await engine.releaseCheckoutHold({ holdId: draft.holdId, checkoutSessionId: draft.checkoutSessionId, reason: "Used for the membership's first visit" }).catch(() => null);
      }
      try {
        ({ booking } = await engine.createBookingWithReservation({ bookingData, slotStart: draft.slotStart, createdByType: "customer", actorUser: user, assignmentSource: "automatic" }));
      } catch (error) {
        if (["SLOT_UNAVAILABLE", "SLOT_CONFLICT", "TECHNICIAN_UNAVAILABLE"].includes(error?.code) || /no longer available|unavailable/i.test(String(error?.message || ""))) {
          if (exemptionClaimed) await releaseFirstVisitExemption(exemptionClaimed);
          exemptionClaimed = null;
          return needsAdmin(draft, "slot_unavailable", { user, home });
        }
        throw error;
      }
    } else {
      booking = await new Booking(bookingData).save();
    }

    if (exemptionClaimed) await attachFirstVisitBooking(exemptionClaimed, booking._id).catch(() => null);
    const booked = await Draft.findOneAndUpdate(
      { _id: draft._id },
      { $set: { status: "booked", bookingId: booking._id, bookedAt: new Date(), subscriptionId: subscription._id, failureReason: "" } },
      { new: true }
    );
    log("info", "first_visit_booked", { draftId: String(draft._id), bookingId: String(booking._id) });
    await sendBookingNotices({ booking, user, home });
    return booked;
  } catch (error) {
    if (exemptionClaimed) await releaseFirstVisitExemption(exemptionClaimed).catch(() => null);
    log("error", "first_visit_fulfillment_failed", { draftId: String(draft._id), attempt: draft.attempts, error: String(error?.message || error).slice(0, 200) });
    if (draft.attempts >= MAX_ATTEMPTS) return needsAdmin(draft, "booking_failed", { user, home });
    return Draft.findOneAndUpdate({ _id: draft._id, status: "fulfilling" }, { $set: { status: "paid" } }, { new: true });
  }
}

/** The customer booked another time themselves after a needs_admin: close it. */
async function closeFirstVisitDraftsFor(subscriptionId, bookingId) {
  if (!subscriptionId) return;
  await Draft.updateMany({ subscriptionId, status: "needs_admin" }, { $set: { status: "rebooked", bookingId } });
}

/**
 * The safety net (every few minutes, jobs/oneTimeVisitHolds.js): a paid draft
 * the webhook could not finish, or a claim abandoned mid-way, is booked now.
 */
async function sweepFirstVisitDrafts(now = new Date()) {
  const due = await Draft.find({
    $or: [
      { status: "paid", updatedAt: { $lt: new Date(now.getTime() - 60 * 1000) } },
      { status: "fulfilling", fulfillingAt: { $lt: new Date(now.getTime() - STALE_FULFILLING_MS) } },
    ],
  })
    .select("_id")
    .limit(20)
    .lean();
  let done = 0;
  for (const d of due) {
    const after = await fulfillFirstVisitDraft(d._id, { now });
    if (after?.status === "booked" || after?.status === "needs_admin") done += 1;
  }
  return done;
}

/** What the success page may show the customer about their draft. */
async function firstVisitDraftView(draftId, userId) {
  const draft = await Draft.findOne({ _id: draftId, user: userId }).lean();
  if (!draft) return null;
  const booking = draft.bookingId ? await Booking.findById(draft.bookingId).select("bookingNumber date status").lean() : null;
  return {
    id: String(draft._id),
    status: draft.status,
    reason: draft.failureReason || "",
    requestedDate: draft.requestedDate,
    requestedTime: draft.requestedTime,
    earliestMemberDate: earliestMemberVisitYMD(),
    booking: booking ? { bookingNumber: booking.bookingNumber, date: booking.date, status: booking.status } : null,
  };
}

module.exports = {
  createFirstVisitDraft,
  draftForCheckout,
  attachDraftToCheckout,
  markFirstVisitPaid,
  markFirstVisitExpired,
  fulfillFirstVisitDraft,
  closeFirstVisitDraftsFor,
  sweepFirstVisitDrafts,
  firstVisitDraftView,
  draftIdFromSession,
};
