const mongoose = require("mongoose");
const moment = require("moment-timezone");

const Booking = require("../../models/Booking");
const User = require("../../models/User");
const VisitEntitlement = require("../../models/VisitEntitlement");
const CalendarConfig = require("../../models/CalendarConfig");
const SlotCounter = require("../../models/SlotCounter");
const mail = require("../emailService");
const adminSubjects = require("../adminSubjects");
const generalFixterNotify = require("../generalFixterNotify");
const smsNotify = require("../sms/smsNotifications");
const { normalizeEmail, normalizePhoneE164 } = require("../identity");
const { buildAddress } = require("../customerProfileEdit");
const { storeAppointmentImages } = require("../bookingAttachments");
const { deletePublicObjects } = require("../s3");
const { cancelBookingWithReservation, createBookingWithReservation, isTerminalBookingStatus, reservationEngineEnabled } = require("../slotReservationService");
const { createFullDayBooking, FULL_DAY_PRODUCT_KIND, FULL_DAY_SERVICE } = require("../fullDayVisitService");
const { getFullDayVisitSettings } = require("../fullDayVisitSettings");
const { getOneTimeVisitSettings } = require("../oneTimeVisitSettings");
const { ensureVisitEntitlementIndexesOnce } = require("../visitEntitlementIndexSafety");
const { stripe, hasStripeSecretKey, resolveUserStripeCustomerId } = require("../subscriptionManagement");
const { logBookingCreated } = require("../bookingHistory");
const { createLink, sendLink } = require("./paymentLinks");

/**
 * Admin creates a visit: for a customer, or for somebody with no account.
 *
 * Four kinds, each held to the rules that kind already has:
 *
 *  membership  the home must have an active membership (verified with Stripe)
 *              and the plan's limit on booked visits is enforced. The member
 *              seven-day lead time is the customer route's rule and, as that
 *              route says, does not bind what Admin books.
 *  one_time    paid: a held slot plus a Stripe Checkout, the same entitlement
 *  full_day    and webhook confirmation as a customer purchase. Pay by phone
 *              opens it on Admin's screen; a link sends it to the customer.
 *  admin_free  "Free Visit — Admin": the owner's discretionary visit. No
 *              payment, no entitlement, unlimited. accessType "admin" keeps it
 *              out of every free-first-visit rule (eligibility reads
 *              isFreeFirstVisit / accessType "free_first_visit" /
 *              guestRequestId - none set here) and out of the plan limit
 *              (routes/bookings.js counts accessType != "admin").
 *
 * Slots go through the same reservation engine, so availability, technician
 * choice and double-booking protection are exactly the customer's.
 */

const TZ = "America/New_York";
const KINDS = new Set(["membership", "one_time", "full_day", "admin_free"]);
const LINK_HOLD_MS = 23 * 60 * 60 * 1000 + 50 * 60 * 1000; // inside Stripe's 24 h ceiling
const ADMIN_FREE_LABEL = "Free Visit — Admin";

class AdminVisitError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

function clean(value, max) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function readBool(value) {
  return value === true || value === "true" || value === "1" || value === "on";
}

function readChannels(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  const set = new Set(list.map((v) => String(v).trim()).filter((v) => v === "email" || v === "sms"));
  return set.size ? [...set] : ["email", "sms"];
}

function slotStartFor(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) return null;
  if (!/^\d{2}:\d{2}$/.test(String(time || ""))) return null;
  const start = moment.tz(`${date} ${time}`, "YYYY-MM-DD HH:mm", true, TZ);
  return start.isValid() ? start.toDate() : null;
}

function itemLabelFor(kind, date) {
  const day = moment.tz(date, TZ).format("ddd, MMM D");
  if (kind === "full_day") return `your Full Day on ${day}`;
  return `your One-Time Visit on ${day}`;
}

/** Who the visit is for: an account and one of its homes, or a guest's typed details. */
async function resolveCustomer(body) {
  const mode = body.mode === "guest" ? "guest" : "existing";
  if (mode === "existing") {
    if (!mongoose.isValidObjectId(body.userId)) throw new AdminVisitError("CUSTOMER_REQUIRED", "Choose the customer.");
    const user = await User.findById(body.userId);
    if (!user || user.role === "employee" || user.role === "admin" || user.employeePosition) {
      throw new AdminVisitError("CUSTOMER_NOT_FOUND", "Customer not found.", 404);
    }
    if (!mongoose.isValidObjectId(body.addressId)) throw new AdminVisitError("ADDRESS_REQUIRED", "Choose the service address.");
    const address = user.addresses.id(body.addressId);
    if (!address) throw new AdminVisitError("ADDRESS_NOT_FOUND", "That address is not on this customer's account.");
    if (!user.email || !user.phone) {
      throw new AdminVisitError("CONTACT_REQUIRED", "Add the customer's email and phone first (Edit).", 400);
    }
    return {
      mode,
      user,
      address: { _id: address._id, line1: address.line1, city: address.city, state: address.state, zip: address.zip, county: address.county || "" },
      contact: { name: user.name || "", email: user.email, phone: user.phone },
    };
  }

  const errors = {};
  const name = clean(body.guestName, 120);
  const email = normalizeEmail(body.guestEmail);
  const phone = normalizePhoneE164(body.guestPhone);
  if (!name) errors.guestName = "Enter the name.";
  if (!phone) errors.guestPhone = "Enter a valid phone.";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.guestEmail = "Enter a valid email.";
  const built = buildAddress(
    { line1: body.guestLine1, unit: body.guestUnit, city: body.guestCity, state: body.guestState || "NY", zip: body.guestZip },
    null,
    0
  );
  if (built.errors) {
    for (const [key, message] of Object.entries(built.errors)) errors[key.replace("addresses.0.", "guest_")] = message;
  }
  if (Object.keys(errors).length) throw new AdminVisitError("INVALID", "Please check the highlighted fields.", 400, { errors });
  return {
    mode,
    user: null,
    address: { _id: null, ...built.address },
    contact: { name, email, phone },
    smsConsent: readBool(body.guestSmsConsent),
  };
}

function baseBookingData({ who, start, bookingNumber, task, description, adminNote, images, admin }) {
  return {
    bookingNumber,
    date: start,
    service: task,
    user: who.user?._id || null,
    userId: who.user?.userId || "",
    name: who.contact.name,
    phone: who.contact.phone,
    email: who.contact.email,
    addressId: who.address._id || null,
    address: who.address.line1 || "",
    city: who.address.city || "",
    state: who.address.state || "",
    zip: who.address.zip || "",
    county: who.address.county || "",
    isFreeFirstVisit: false,
    note: description,
    adminNote,
    images,
    status: "Pending",
    adminGuest: !who.user,
    createdByAdmin: { by: admin?._id || null, byName: String(admin?.name || admin?.email || "").slice(0, 120), at: new Date() },
    ...(who.user
      ? {}
      : who.smsConsent
        ? {
            guestContactConsent: {
              text: `Agreed by phone to be contacted by call or text about this visit; recorded in Admin by ${String(admin?.name || admin?.email || "staff").slice(0, 60)}.`,
              at: new Date(),
              ip: "",
            },
          }
        : {}),
  };
}

/** Membership visit: an active plan at this home, and room under its limit. */
async function assertMembershipVisitAllowed(who) {
  if (!who.user) throw new AdminVisitError("MEMBERSHIP_NEEDS_ACCOUNT", "Membership visits are for customers with an account.");
  const { resolveBookingSubscription, resolvePlanCapacity } = require("../../routes/bookings");
  const access = await resolveBookingSubscription(who.user, who.address, { verifyStripe: true });
  if (access.staleSubscription) {
    throw new AdminVisitError("SUBSCRIPTION_ACCESS_INACTIVE", "This membership could not be verified as active with Stripe.", 409);
  }
  const activeSub = access.subscription;
  if (!activeSub) throw new AdminVisitError("NO_ACTIVE_MEMBERSHIP", "This home has no active membership.", 409);
  const capacity = await resolvePlanCapacity(activeSub);
  const future = await Booking.find({
    user: who.user._id,
    addressId: who.address._id,
    date: { $gte: new Date() },
    accessType: { $ne: "admin" },
  })
    .select("status")
    .lean();
  const active = future.filter((b) => !isTerminalBookingStatus(b.status)).length;
  if (capacity.bookingLimit > 0 && active >= capacity.bookingLimit) {
    throw new AdminVisitError(
      "MEMBERSHIP_LIMIT_REACHED",
      capacity.bookingLimit === 1
        ? "This member already has a visit booked for this home (Basic: 1 at a time)."
        : `This member already has ${active} visits booked for this home (limit ${capacity.bookingLimit}).`,
      409
    );
  }
  return activeSub;
}

/** A 90-minute visit through the same slot protection as a customer booking. */
async function createSlotBooking({ bookingData, start, admin, reservationStatus = "reserved", holdExpiresAt = null }) {
  if (reservationEngineEnabled()) {
    const result = await createBookingWithReservation({
      bookingData,
      slotStart: start,
      createdByType: "admin",
      actorUser: admin?._id ? await User.findById(admin._id) : null,
      assignmentSource: "automatic",
      reservationStatus,
      holdExpiresAt,
    });
    return { booking: result.booking, counter: null };
  }
  const cfg = await CalendarConfig.findOne().lean();
  const tz = cfg?.timezone || TZ;
  const capacity = Math.max(1, Number(cfg?.maxConcurrent ?? 1));
  const ymd = moment.tz(start, tz).format("YYYY-MM-DD");
  const hh = moment.tz(start, tz).format("HH:mm");
  const gate = await SlotCounter.findOneAndUpdate(
    { ymd, time: hh, $or: [{ count: { $lt: capacity } }, { count: { $exists: false } }] },
    { $inc: { count: 1 }, $setOnInsert: { ymd, time: hh } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).catch((error) => {
    if (error?.code === 11000) return null;
    throw error;
  });
  if (!gate || gate.count > capacity) {
    throw new AdminVisitError("SLOT_UNAVAILABLE", "This time is fully booked. Choose another time.", 409);
  }
  try {
    const booking = await new Booking(bookingData).save();
    await logBookingCreated({
      booking,
      actor: { actorUserId: admin?._id || null, actorName: admin?.name || "Admin", actorEmail: admin?.email || "", actorRole: "admin", actorPosition: "" },
    }).catch(() => {});
    return { booking, counter: { ymd, time: hh } };
  } catch (error) {
    await SlotCounter.updateOne({ ymd, time: hh, count: { $gt: 0 } }, { $inc: { count: -1 } }).catch(() => {});
    throw error;
  }
}

/** The customer, Admin and crew are told about a visit that needs no payment. */
async function notifyUnpaidVisit({ booking, who }) {
  const addressLine = [booking.address, booking.city, booking.state, booking.zip].filter(Boolean).join(", ");
  const when = moment.tz(booking.date, TZ).format("dddd, MMMM D, YYYY [at] h:mm A");
  try {
    await mail.sendTx(
      "booking_created",
      booking.email,
      { name: booking.name || "there", bookingNumber: booking.bookingNumber, date: booking.date, service: booking.service, address: addressLine },
      {
        bccAdmin: false,
        logContext: {
          bookingId: booking._id,
          bookingNumber: booking.bookingNumber,
          userId: who.user?._id || null,
          customerName: booking.name || "",
          customerEmail: booking.email || "",
          recipientName: booking.name || "",
          recipientEmail: booking.email || "",
          emailType: "transactional",
          source: "adminVisitCreate",
        },
      }
    );
  } catch (error) {
    console.error("admin visit booking_created email failed:", error.message);
  }
  try {
    await mail.sendPromo(process.env.MAIL_ADMIN || "getfixter@gmail.com", {
      subject: adminSubjects.booking("New Booking (Admin)", { name: booking.name, date: booking.date }),
      html: `<h2>Booking created in Admin</h2>
        <ul>
          <li><strong>Name:</strong> ${mail.escapeHtml(booking.name)}${who.user ? "" : " (no account)"}</li>
          <li><strong>Email:</strong> ${mail.escapeHtml(booking.email)}</li>
          <li><strong>Phone:</strong> ${mail.escapeHtml(booking.phone)}</li>
          <li><strong>Type:</strong> ${mail.escapeHtml(booking.accessType === "admin" ? ADMIN_FREE_LABEL : "Membership visit")}</li>
          <li><strong>Task:</strong> ${mail.escapeHtml(booking.service)}</li>
          <li><strong>Date:</strong> ${mail.escapeHtml(when)}</li>
          <li><strong>Address:</strong> ${mail.escapeHtml(addressLine)}</li>
          <li><strong>Booking #:</strong> ${mail.escapeHtml(booking.bookingNumber)}</li>
          <li><strong>Photos:</strong> ${(booking.images || []).length || "None"}</li>
          <li><strong>Created by:</strong> ${mail.escapeHtml(booking.createdByAdmin?.byName || "Admin")}</li>
        </ul>`,
      logContext: {
        templateKey: "admin_booking_created",
        bookingId: booking._id,
        bookingNumber: booking.bookingNumber,
        customerName: booking.name || "",
        customerEmail: booking.email || "",
        recipientEmail: process.env.MAIL_ADMIN || "getfixter@gmail.com",
        emailType: "admin",
        source: "adminVisitCreate",
      },
    });
  } catch (error) {
    console.error("admin visit admin notice failed:", error.message);
  }
  await smsNotify.notifyBookingConfirmed(booking, who.user || null, "adminVisitCreate");
  try {
    await generalFixterNotify.bookingCreated(mail, {
      bookingId: booking._id,
      bookingNumber: booking.bookingNumber,
      customerName: booking.name || "",
      customerEmail: booking.email || "",
      phone: booking.phone || "",
      date: booking.date,
      service: booking.service,
      bookingType: booking.accessType === "admin" ? ADMIN_FREE_LABEL : "Membership Visit",
      address: addressLine,
      note: booking.note || "",
      source: "adminVisitCreate",
    });
  } catch (error) {
    console.error("admin visit crew notice failed:", error.message);
  }
}

/** Stripe Checkout for a held paid visit. Same metadata the customer's checkout carries. */
async function openVisitCheckout({ booking, entitlement, who, kind, priceId, expiresAt, successUrl, cancelUrl, extraMetadata = {} }) {
  const metadata = {
    productKind: kind === "full_day" ? FULL_DAY_PRODUCT_KIND : "one_time_handyman_visit",
    bookingId: String(booking._id),
    entitlementId: entitlement ? String(entitlement._id) : "",
    userMongoId: who.user ? String(who.user._id) : "",
    userId: who.user ? String(who.user.userId || who.user._id) : "",
    addressId: who.address._id ? String(who.address._id) : "",
    adminInitiated: "true",
    ...Object.fromEntries(Object.entries(extraMetadata).map(([k, v]) => [k, String(v ?? "")])),
  };
  const stripeCustomerId = who.user ? await resolveUserStripeCustomerId(who.user) : null;
  const config = {
    mode: "payment",
    payment_method_types: ["card"],
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: String(booking._id),
    metadata,
    payment_intent_data: { metadata },
    success_url: successUrl,
    cancel_url: cancelUrl,
    expires_at: Math.floor(expiresAt.getTime() / 1000),
    ...(stripeCustomerId ? { customer: stripeCustomerId } : { customer_email: who.contact.email }),
  };
  const session = await stripe.checkout.sessions.create(config);
  if (!session?.url) throw new Error("Stripe checkout did not return a redirect URL");
  if (entitlement) {
    entitlement.stripeCheckoutSessionId = session.id;
    entitlement.stripeCustomerId = session.customer ? String(session.customer) : stripeCustomerId || null;
    await entitlement.save();
  }
  return session;
}

async function releaseUnpayableVisit({ booking, entitlement, admin }) {
  if (reservationEngineEnabled()) {
    await cancelBookingWithReservation({
      bookingId: booking._id,
      actorUser: admin?._id ? await User.findById(admin._id) : null,
      createdByType: "admin",
      reason: "Admin visit payment could not be started",
    });
  } else {
    await Booking.updateOne({ _id: booking._id }, { $set: { status: "Canceled", paymentState: "failed" } });
  }
  if (entitlement) await VisitEntitlement.updateOne({ _id: entitlement._id }, { $set: { status: "canceled" } }).catch(() => {});
}

/**
 * Create the visit. `files` are multer files already sanitized.
 * Returns { booking, payment } where payment is null (no payment needed),
 * { method: "phone", url } or { method: "link", payUrl, delivery, expiresAt }.
 */
async function createAdminVisit({ body = {}, files = [], admin, clientUrl }) {
  const kind = String(body.type || "");
  if (!KINDS.has(kind)) throw new AdminVisitError("TYPE_REQUIRED", "Choose the visit type.");
  const who = await resolveCustomer(body);

  const task = clean(body.task, 120);
  const description = String(body.description || "").trim().slice(0, 4000);
  const adminNote = String(body.notes || "").trim().slice(0, 2000);
  if (!task) throw new AdminVisitError("INVALID", "Please check the highlighted fields.", 400, { errors: { task: "Enter the task." } });

  const isFullDay = kind === "full_day";
  const start = isFullDay ? null : slotStartFor(body.date, body.time);
  if (isFullDay && !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date || ""))) {
    throw new AdminVisitError("INVALID", "Please check the highlighted fields.", 400, { errors: { date: "Choose the date." } });
  }
  if (!isFullDay && !start) {
    throw new AdminVisitError("INVALID", "Please check the highlighted fields.", 400, { errors: { time: "Choose the date and time." } });
  }
  if (start && start.getTime() < Date.now() - 5 * 60 * 1000) {
    throw new AdminVisitError("INVALID", "That time has already passed.", 400, { errors: { time: "Choose a future time." } });
  }

  const paid = kind === "one_time" || kind === "full_day";
  const method = body.payment === "link" ? "link" : "phone";
  let settings = null;
  if (paid) {
    if (!hasStripeSecretKey()) throw new AdminVisitError("STRIPE_NOT_CONFIGURED", "Payments are unavailable right now.", 503);
    settings = isFullDay ? await getFullDayVisitSettings() : await getOneTimeVisitSettings();
    if (!settings.enabled) throw new AdminVisitError("DISABLED", isFullDay ? "Full Day booking is switched off." : "One-Time Visits are switched off.", 503);
    if (!settings.stripePriceId) throw new AdminVisitError("PRICE_NOT_CONFIGURED", "This visit has no Stripe price set.", 503);
  }

  let activeSub = null;
  if (kind === "membership") activeSub = await assertMembershipVisitAllowed(who);

  const bookingNumber = Math.floor(10000000 + Math.random() * 90000000).toString();
  const photoDate = start || new Date(`${body.date}T12:00:00Z`);
  const stored = await storeAppointmentImages({ files, bookingDate: photoDate, bookingNumber, source: "admin-create" });
  const uploadedS3Keys = stored.uploadedS3Keys;

  let booking = null;
  let entitlement = null;
  try {
    const bookingData = baseBookingData({ who, start: start || photoDate, bookingNumber, task, description, adminNote, images: stored.images, admin });

    if (!paid) {
      Object.assign(
        bookingData,
        kind === "membership"
          ? { subscription: activeSub.subscriptionType, accessType: "membership", bookingType: "membership_visit", paymentState: "not_required" }
          : { subscription: ADMIN_FREE_LABEL, accessType: "admin", bookingType: "membership_visit", paymentState: "not_required" }
      );
      ({ booking } = await createSlotBooking({ bookingData, start, admin }));
      await notifyUnpaidVisit({ booking, who });
      return { booking, payment: null };
    }

    const holdExpiresAt = new Date(Date.now() + (method === "link" ? LINK_HOLD_MS : Math.max(30, settings.holdMinutes || 30) * 60 * 1000));
    if (who.user) {
      await ensureVisitEntitlementIndexesOnce();
      entitlement = await VisitEntitlement.create({
        user: who.user._id,
        userId: who.user.userId,
        addressId: who.address._id,
        addressSnapshot: { line1: who.address.line1 || "", city: who.address.city || "", state: who.address.state || "", zip: who.address.zip || "", county: who.address.county || "" },
        ...(isFullDay ? { kind: "full_day_visit", source: "purchase", durationMinutes: settings.approximateHours * 60 } : { durationMinutes: settings.durationMinutes }),
        status: "pending_payment",
        priceCents: settings.priceCents,
        currency: settings.currency,
        holdExpiresAt,
      });
    }
    Object.assign(bookingData, {
      accessType: "one_time",
      bookingType: isFullDay ? "full_day_visit" : "one_time_handyman_visit",
      subscription: isFullDay ? "Full Day Fixter" : "One-Time Visit",
      paymentState: "pending",
      paymentStatus: "Pending",
      entitlementId: entitlement?._id || null,
      paymentHoldExpiresAt: holdExpiresAt,
      ...(isFullDay ? { selectedTask: FULL_DAY_SERVICE } : { selectedTask: task }),
    });

    if (isFullDay) {
      const result = await createFullDayBooking({
        date: body.date,
        actorUser: admin?._id ? await User.findById(admin._id) : null,
        createdByType: "admin",
        reservationStatus: "held",
        holdExpiresAt,
        bookingData: { ...bookingData, service: FULL_DAY_SERVICE, note: [task, description].filter(Boolean).join("\n") },
      });
      booking = result.booking;
    } else {
      ({ booking } = await createSlotBooking({ bookingData, start, admin, reservationStatus: "held", holdExpiresAt }));
    }
    if (entitlement) {
      entitlement.bookingId = booking._id;
      await entitlement.save();
    }

    if (method === "phone") {
      const session = await openVisitCheckout({
        booking,
        entitlement,
        who,
        kind,
        priceId: settings.stripePriceId,
        expiresAt: holdExpiresAt,
        successUrl: `${clientUrl}/admin?tab=bookings&paid=visit`,
        cancelUrl: `${clientUrl}/admin?tab=bookings`,
      });
      return { booking, payment: { method: "phone", url: session.url, expiresAt: holdExpiresAt } };
    }

    /*
     * The visit's Stripe page is made now, timed to its slot hold, and the
     * link simply reopens it: paying after the hold is impossible because the
     * page closes with it.
     */
    const contact = { name: who.contact.name, email: who.contact.email, phone: who.contact.phone, user: who.user, booking };
    const { link, token, payUrl } = await createLink({
      kind,
      contact,
      itemLabel: itemLabelFor(kind, booking.date),
      channels: readChannels(body.channels),
      expiresAt: holdExpiresAt,
      admin,
    });
    const session = await openVisitCheckout({
      booking,
      entitlement,
      who,
      kind,
      priceId: settings.stripePriceId,
      expiresAt: holdExpiresAt,
      successUrl: `${clientUrl}/pay/${token}?paid=1`,
      cancelUrl: `${clientUrl}/pay/${token}`,
      extraMetadata: { adminPaymentLinkId: String(link._id) },
    });
    link.lastSessionId = session.id;
    await link.save();
    const delivery = await sendLink({ link, payUrl, contact });
    return { booking, payment: { method: "link", payUrl, delivery, expiresAt: holdExpiresAt, linkId: String(link._id) } };
  } catch (error) {
    if (!booking && uploadedS3Keys.length) await deletePublicObjects({ Keys: uploadedS3Keys }).catch(() => {});
    if (!booking && entitlement) await VisitEntitlement.deleteOne({ _id: entitlement._id }).catch(() => {});
    /*
     * A paid visit whose checkout or link could not be made must not sit on
     * its held slot until the hold runs out: release it now.
     */
    if (booking && paid) {
      await releaseUnpayableVisit({ booking, entitlement, admin }).catch((releaseError) =>
        console.error("admin visit release after failure failed:", releaseError.message)
      );
    }
    if (error?.code === "SLOT_UNAVAILABLE" || error?.code === "FULL_DAY_UNAVAILABLE" || /unavailable/i.test(String(error?.code || ""))) {
      throw new AdminVisitError(String(error.code), error.message || "That time is no longer available.", 409);
    }
    throw error;
  }
}

module.exports = {
  ADMIN_FREE_LABEL,
  AdminVisitError,
  createAdminVisit,
  itemLabelFor,
  openVisitCheckout,
};
