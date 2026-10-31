/**
 * A homepage free-visit request, from the moment it is made to the visit.
 *
 *   request  -> Booking "Pending Confirmation" + its slot reserved + the lead,
 *               in ONE transaction (reserveGuestFreeVisit)
 *   owner    -> calls, fixes details / address / time (updateGuestVisit)
 *   confirm  -> the same Booking becomes "Confirmed", the same reservation
 *               stays, the customer gets the normal confirmation once
 *               (confirmGuestVisit)
 *   decline  -> the reservation is released, the lead says so, and the free
 *               visit is NOT used up (declineGuestVisit)
 *
 * The Booking is the visit and the Request is its lead. Every status change
 * goes through syncLeadFromBooking so the two never disagree.
 *
 * ONLINE FREE VISITS (freeVisitChannel "online") use the same review: the
 * customer booked with their own account and address, the booking waits in
 * "Pending Confirmation" with its slot reserved, and the owner approves or
 * declines it here. They have no lead and are already on an account, so
 * confirm skips the account linking and the owner cannot rewrite the
 * customer's contact details or address from this screen - those live on the
 * account (Admin > Users > Edit).
 */
const moment = require("moment-timezone");

const Booking = require("../../models/Booking");
const Request = require("../../models/Request");
const User = require("../../models/User");
const mail = require("../emailService");
const smsNotify = require("../sms/smsNotifications");
const generalFixterNotify = require("../generalFixterNotify");
const { libraryLabel } = require("../bookingLibrary");
const { normalizePhoneE164 } = require("../identity");
const { isAddressInServiceArea, countyForZip, outOfServiceAreaMessage } = require("../serviceArea");
const { runReservationTransaction } = require("../reservationTransaction");
const { logBookingChanges, snapshot: bookingSnapshot } = require("../bookingHistory");
const {
  cancelBookingWithReservation,
  createBookingWithReservation,
  findEligibleTechnicians,
  moveReservationForBooking,
  resetBookingReminderEmailStateForDateChange,
} = require("../slotReservationService");
const {
  acquireFreeVisitLock,
  addressMatchKey,
  blockedError,
  canonicalEmail,
  checkFreeVisitEligibility,
} = require("./eligibility");
const { releaseIntroVisitClaim } = require("../introVisitEligibility");

const TIMEZONE = "America/New_York";
const PENDING = "Pending Confirmation";
const FREE_VISIT_SERVICE = "Labor Only";

function serviceError(code, message, statusCode = 409, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function isPendingGuest(booking) {
  return Boolean(booking?.guestRequestId) && String(booking.status || "").toLowerCase() === PENDING.toLowerCase();
}

function isOnlineFreeVisit(booking) {
  return !booking?.guestRequestId && booking?.freeVisitChannel === "online" && Boolean(booking?.user);
}

/** A free visit the owner reviews on the free-visit screen: callback or online. */
function isReviewableFreeVisit(booking) {
  return Boolean(booking?.guestRequestId) || isOnlineFreeVisit(booking);
}

/** Either kind, still waiting for the owner. */
function isPendingFreeVisit(booking) {
  return isReviewableFreeVisit(booking) && String(booking.status || "").toLowerCase() === PENDING.toLowerCase();
}

function channelOf(booking) {
  return booking?.guestRequestId ? "callback" : isOnlineFreeVisit(booking) ? "online" : "";
}

/* Online visits are booked through the engine in production; the legacy path has no reservation to require. */
function reservationRequired() {
  return process.env.ENABLE_RESERVATION_ENGINE === "true";
}

function nextBookingNumber() {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
}

function addressLine(booking) {
  return [booking.address, booking.city, booking.state, booking.zip].filter(Boolean).join(", ");
}

function reviewFrom(result, now = new Date()) {
  return {
    required: result.decision === "review",
    reasons: result.decision === "review" ? result.reasons : [],
    matches: result.matches.slice(0, 10),
    checkedAt: now,
    acknowledgedAt: null,
    acknowledgedBy: null,
  };
}

/* ------------------------------------------------------------------ */
/* Lead <-> visit                                                       */
/* ------------------------------------------------------------------ */

/** The lead status a visit's state implies. */
function leadStatusFor(booking) {
  const status = String(booking.status || "").toLowerCase();
  if (booking.completedAt || ["completed", "complete", "done"].includes(status)) return "completed";
  if (["canceled", "cancelled"].includes(status)) {
    return booking.freeVisitConfirmation?.declinedAt ? "declined" : "canceled";
  }
  if (status === PENDING.toLowerCase()) return "pending_confirmation";
  return "confirmed";
}

/**
 * Make the lead say what the visit says: status, who, what, when.
 * Safe to call after any change to a guest booking, from any route.
 */
async function syncLeadFromBooking(bookingOrId, { session = null } = {}) {
  const booking =
    bookingOrId && bookingOrId._id && bookingOrId.status !== undefined
      ? bookingOrId
      : await Booking.findById(bookingOrId).session(session).lean();
  if (!booking?.guestRequestId) return null;
  const when = moment.tz(booking.date, TIMEZONE);
  const set = {
    status: leadStatusFor(booking),
    name: booking.name,
    phone: booking.phone,
    email: booking.email,
    message: booking.note,
    requestedDate: when.format("YYYY-MM-DD"),
    requestedTime: when.format("HH:mm"),
    requestedAt: new Date(booking.date),
    address: addressLine(booking),
    bookingId: booking._id,
  };
  await Request.updateOne({ _id: booking.guestRequestId }, { $set: set }, session ? { session } : {});
  return set.status;
}

/* ------------------------------------------------------------------ */
/* 1. The request                                                       */
/* ------------------------------------------------------------------ */

/**
 * Reserve the slot and write the lead, atomically.
 *
 * `request` is an unsaved Request document (its _id is already minted so photos
 * can be stored under it). `bookingData` holds the visit's fields. If the slot
 * is taken, the person already has a free visit, or anything fails, nothing at
 * all is written: no booking, no reservation, no lead.
 */
async function reserveGuestFreeVisit({ request, bookingData, slotStart, existingRequest = false }) {
  let eligibility = null;
  const data = {
    bookingNumber: nextBookingNumber(),
    service: FREE_VISIT_SERVICE,
    subscription: "Free visit",
    accessType: "free_first_visit",
    bookingType: "membership_visit",
    paymentState: "not_required",
    // Not a counted free visit until the owner confirms it; see models/Booking.
    isFreeFirstVisit: false,
    status: PENDING,
    user: null,
    userId: "",
    address: "",
    ...bookingData,
    guestRequestId: request._id,
    freeVisitChannel: "callback",
  };

  const result = await createBookingWithReservation({
    bookingData: data,
    slotStart,
    createdByType: "customer",
    actorUser: null,
    assignmentSource: "automatic",
    beforeCreate: async (session) => {
      await acquireFreeVisitLock(session);
      // The new Free Visit form collects the address up front, so it counts in the lifetime check now.
      const addressKey = data.address ? addressMatchKey({ line1: data.address, city: data.city, state: data.state, zip: data.zip }) : "";
      eligibility = await checkFreeVisitEligibility(
        { phone: data.phone, email: data.email, ...(addressKey ? { address: addressKey } : {}) },
        { session, excludeRequestId: existingRequest ? request._id : null }
      );
      if (eligibility.decision === "blocked") throw blockedError(eligibility);
      const now = new Date();
      data.freeVisitReview = reviewFrom(eligibility, now);
      data.freeVisitIdentity = {
        phone: eligibility.identity.phone,
        email: eligibility.identity.email,
        addressKey: eligibility.identity.addressKey || "",
        userId: null,
        capturedAt: now,
      };
    },
    afterCreate: async ({ session, booking }) => {
      if (existingRequest) {
        // Backfill: claim the older request only if nobody else linked it first.
        const linked = await Request.updateOne(
          { _id: request._id, $or: [{ bookingId: null }, { bookingId: { $exists: false } }] },
          { $set: { bookingId: booking._id, reservationIssue: { code: "", message: "", at: null } } },
          { session }
        );
        if (linked.modifiedCount !== 1) throw serviceError("REQUEST_ALREADY_LINKED", "Request already has a visit");
      } else {
        request.bookingId = booking._id;
        request.isNew = true;
        await request.save({ session });
      }
    },
  });

  return { ...result, eligibility };
}

/* ------------------------------------------------------------------ */
/* 2. The owner's edits                                                 */
/* ------------------------------------------------------------------ */

function cleanText(value, max = 200) {
  return String(value ?? "").replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** The address the owner typed, validated. Returns { address } or { error }. */
function readAddress(input = {}) {
  const line1 = cleanText(input.line1, 160);
  const unit = cleanText(input.unit, 40);
  const city = cleanText(input.city, 80);
  const state = cleanText(input.state || "NY", 2).toUpperCase();
  const zip = cleanText(input.zip, 10).split("-")[0];
  if (!line1 || !/\d/.test(line1)) return { error: "Enter the street address, with the house number." };
  if (!city) return { error: "Enter the city." };
  if (!/^[A-Z]{2}$/.test(state)) return { error: "Enter the state as two letters." };
  if (!/^\d{5}$/.test(zip)) return { error: "Enter a 5-digit ZIP code." };
  return { address: { line1, unit, city, state, zip } };
}

function hasValidAddress(booking) {
  return Boolean(
    String(booking.address || "").trim() &&
      String(booking.city || "").trim() &&
      /^\d{5}$/.test(String(booking.zip || "").trim())
  );
}

/**
 * Save what the owner learned on the call: contact details, address, the job,
 * and (with the normal availability and conflict checks) a different time.
 * Only while the visit is still awaiting confirmation.
 */
async function updateGuestVisit({ bookingId, fields = {}, req = null, actorUser = null }) {
  let booking = await Booking.findById(bookingId);
  if (!isReviewableFreeVisit(booking)) throw serviceError("NOT_A_GUEST_VISIT", "This is not a free-visit request.", 404);
  if (!isPendingFreeVisit(booking)) {
    throw serviceError("NOT_PENDING", "Only a visit awaiting confirmation can be edited here.", 409);
  }
  if (isOnlineFreeVisit(booking) && (fields.name !== undefined || fields.phone !== undefined || fields.email !== undefined || fields.address)) {
    throw serviceError(
      "EDIT_ON_ACCOUNT",
      "This visit was booked online with the customer's account. Change their contact details or address on the account instead.",
      400
    );
  }
  const before = bookingSnapshot(booking);

  /* A different time first: if the slot is taken, nothing else is changed either. */
  if (fields.date || fields.time) {
    const date = cleanText(fields.date || moment.tz(booking.date, TIMEZONE).format("YYYY-MM-DD"), 10);
    const time = cleanText(fields.time || moment.tz(booking.date, TIMEZONE).format("HH:mm"), 5);
    const slot = moment.tz(`${date} ${time}`, "YYYY-MM-DD HH:mm", true, TIMEZONE);
    if (!slot.isValid()) throw serviceError("INVALID_TIME", "Pick a valid day and time.", 400);
    if (slot.toDate().getTime() !== new Date(booking.date).getTime()) {
      if (slot.isBefore(moment())) throw serviceError("INVALID_TIME", "That time has already passed.", 400);
      const options = await findEligibleTechnicians({
        slotStart: slot.toDate(),
        excludeReservationId: booking.slotReservationId || null,
        excludeBookingId: booking._id,
      });
      const current = booking.assignedFixterId ? String(booking.assignedFixterId) : "";
      const technicianId =
        (current && options.available.some((t) => String(t.id) === current) && current) || options.recommended?.id;
      if (!technicianId) {
        throw serviceError("SLOT_UNAVAILABLE", "That time is not available. Pick another time.", 409);
      }
      try {
        await moveReservationForBooking({
          bookingId: booking._id,
          technicianId,
          slotStart: slot.toDate(),
          actorUser,
          createdByType: "admin",
          assignmentSource: "admin",
        });
      } catch (error) {
        if (["SLOT_CONFLICT", "SLOT_UNAVAILABLE", "TECHNICIAN_UNAVAILABLE"].includes(error?.code) || error?.code === 11000) {
          throw serviceError("SLOT_UNAVAILABLE", "That time is not available. Pick another time.", 409);
        }
        throw error;
      }
      booking = await Booking.findById(booking._id);
    }
  }

  if (fields.name !== undefined) {
    const name = cleanText(fields.name, 120);
    if (name.length < 2) throw serviceError("INVALID_NAME", "Enter the customer's name.", 400);
    booking.name = name;
  }
  if (fields.phone !== undefined) {
    const phone = normalizePhoneE164(fields.phone);
    if (!phone) throw serviceError("INVALID_PHONE", "Enter a valid 10-digit US phone number.", 400);
    booking.phone = phone;
  }
  if (fields.email !== undefined) {
    const email = cleanText(fields.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw serviceError("INVALID_EMAIL", "Enter a valid email address.", 400);
    booking.email = email;
  }
  if (fields.address) {
    const read = readAddress(fields.address);
    if (read.error) throw serviceError("INVALID_ADDRESS", read.error, 400);
    const a = read.address;
    booking.address = a.unit ? `${a.line1}, Unit ${a.unit}` : a.line1;
    booking.city = a.city;
    booking.state = a.state;
    booking.zip = a.zip;
    booking.county = countyForZip(a.zip) || "";
    booking.freeVisitIdentity = {
      ...(booking.freeVisitIdentity?.toObject?.() || booking.freeVisitIdentity || {}),
      addressKey: addressMatchKey(a),
    };
  }
  if (fields.note !== undefined) {
    const note = String(fields.note || "").trim().slice(0, 1200);
    if (note.split(/\s+/).filter(Boolean).length < 3) {
      throw serviceError("NOTE_REQUIRED", "Describe the job in a few words.", 400);
    }
    booking.note = note;
  }
  if (fields.selectedTask !== undefined) booking.selectedTask = cleanText(fields.selectedTask, 120);
  if (fields.adminNote !== undefined) booking.adminNote = String(fields.adminNote || "").slice(0, 2000);

  await booking.save();
  await logBookingChanges({ bookingId: booking._id, before, after: bookingSnapshot(booking), req });
  await syncLeadFromBooking(booking.toObject());
  return booking;
}

/* ------------------------------------------------------------------ */
/* 3. Confirm                                                           */
/* ------------------------------------------------------------------ */

/** The one customer account this person clearly already has, if any. */
async function linkedCustomerAccount({ phone, email }, session) {
  const or = [];
  if (email) or.push({ email: String(email).toLowerCase() });
  if (phone) or.push({ phone });
  if (!or.length) return null;
  const users = await User.find({ role: "customer", $or: or }).select("_id userId name email phone addresses").session(session).lean();
  const distinct = [...new Map(users.map((u) => [String(u._id), u])).values()];
  return distinct.length === 1 ? distinct[0] : null;
}

/**
 * The owner has called and verified: make it a real appointment.
 *
 * Retains the booking and its reservation (no second calendar entry), re-runs
 * the lifetime check with the address now known, links the customer's account
 * when one clearly exists, and sends the normal confirmed-appointment email and
 * text exactly once, however many times this is called.
 */
async function confirmGuestVisit({ bookingId, actorUser = null, req = null, acknowledgeReview = false }) {
  const existing = await Booking.findById(bookingId);
  if (!isReviewableFreeVisit(existing)) throw serviceError("NOT_A_GUEST_VISIT", "This is not a free-visit request.", 404);
  if (isOnlineFreeVisit(existing)) return confirmOnlineVisit({ existing, actorUser, req, acknowledgeReview });
  const status = String(existing.status || "").toLowerCase();
  if (status === "confirmed" && existing.freeVisitConfirmation?.confirmedAt) {
    const notified = await notifyConfirmedOnce(existing._id);
    return { booking: existing, alreadyConfirmed: true, notified };
  }
  if (!isPendingGuest(existing)) {
    throw serviceError("NOT_PENDING", `This visit is ${existing.status}; it cannot be confirmed.`, 409);
  }
  if (!hasValidAddress(existing)) {
    throw serviceError("ADDRESS_REQUIRED", "Add and save the customer's service address before confirming.", 400);
  }
  if (!isAddressInServiceArea({ zip: existing.zip })) {
    throw serviceError("OUT_OF_SERVICE_AREA", outOfServiceAreaMessage(), 400);
  }
  if (!existing.slotReservationId) {
    throw serviceError("RESERVATION_MISSING", "This visit has no reserved slot. Pick a time and save first.", 409);
  }
  const before = bookingSnapshot(existing);

  let eligibility = null;
  await runReservationTransaction(async (session) => {
    await acquireFreeVisitLock(session);
    const booking = await Booking.findById(bookingId).session(session);
    if (!isPendingGuest(booking)) throw serviceError("NOT_PENDING", "This visit was changed while you were confirming it.", 409);

    const account = await linkedCustomerAccount({ phone: booking.phone, email: booking.email }, session);
    const addressKey = addressMatchKey({ line1: booking.address, city: booking.city, state: booking.state, zip: booking.zip });
    eligibility = await checkFreeVisitEligibility(
      { phone: booking.phone, email: booking.email, address: addressKey, userId: account?._id },
      { session, excludeBookingId: booking._id, excludeRequestId: booking.guestRequestId }
    );
    if (eligibility.decision === "blocked") {
      throw serviceError(eligibility.code, "This customer has already used or booked a free visit.", 409, { eligibility });
    }
    if (eligibility.decision === "review" && !acknowledgeReview) {
      throw serviceError("REVIEW_REQUIRED", "Possible repeat customer: verify, then confirm again.", 409, { eligibility });
    }

    const now = new Date();
    booking.statusHistory = (booking.statusHistory || []).concat({ status: booking.status, date: now });
    booking.status = "Confirmed";
    booking.isFreeFirstVisit = true;
    booking.freeFirstVisitClaimedAt = now;
    if (account) {
      booking.user = account._id;
      booking.userId = account.userId;
    }
    booking.freeVisitIdentity = {
      phone: eligibility.identity.phone,
      email: canonicalEmail(booking.email),
      addressKey,
      userId: account?._id || null,
      capturedAt: now,
    };
    booking.freeVisitReview = {
      ...reviewFrom(eligibility, now),
      acknowledgedAt: eligibility.decision === "review" ? now : null,
      acknowledgedBy: eligibility.decision === "review" ? actorUser?._id || null : null,
    };
    booking.freeVisitConfirmation = {
      ...(booking.freeVisitConfirmation?.toObject?.() || {}),
      confirmedAt: now,
      confirmedBy: actorUser?._id || null,
      notifyClaimedAt: null,
    };
    resetBookingReminderEmailStateForDateChange(booking, booking.date);
    await booking.save({ session });

    // The account's own per-address record follows, when it has this house.
    if (account) {
      const home = (account.addresses || []).find((a) => addressMatchKey(a) === addressKey);
      if (home) {
        await User.updateOne(
          {
            _id: account._id,
            addresses: {
              $elemMatch: {
                _id: home._id,
                $or: [{ "introVisit.status": { $exists: false } }, { "introVisit.status": null }, { "introVisit.status": "available" }],
              },
            },
          },
          {
            $set: {
              "addresses.$.introVisit.status": "claimed",
              "addresses.$.introVisit.bookingId": booking._id,
              "addresses.$.introVisit.claimedAt": now,
            },
          },
          { session }
        );
        booking.addressId = home._id;
        await booking.save({ session });
      }
    }
    await syncLeadFromBooking(booking.toObject(), { session });
  });

  const booking = await Booking.findById(bookingId);
  await logBookingChanges({ bookingId: booking._id, before, after: bookingSnapshot(booking), req });
  const notified = await notifyConfirmedOnce(booking._id);
  return { booking, alreadyConfirmed: false, notified, eligibility };
}

/**
 * The owner approves a free visit the customer booked online. The account,
 * address and per-address claim were all settled when it was booked; what is
 * left is the lifetime rule once more under the lock (something may have
 * changed while it waited), the status, and the one confirmation.
 */
async function confirmOnlineVisit({ existing, actorUser, req, acknowledgeReview }) {
  const bookingId = existing._id;
  const status = String(existing.status || "").toLowerCase();
  if (status === "confirmed" && existing.freeVisitConfirmation?.confirmedAt) {
    const notified = await notifyConfirmedOnce(existing._id);
    return { booking: existing, alreadyConfirmed: true, notified };
  }
  if (!isPendingFreeVisit(existing)) {
    throw serviceError("NOT_PENDING", `This visit is ${existing.status}; it cannot be confirmed.`, 409);
  }
  if (!hasValidAddress(existing)) {
    throw serviceError("ADDRESS_REQUIRED", "This booking has no complete service address.", 400);
  }
  if (!isAddressInServiceArea({ zip: existing.zip })) {
    throw serviceError("OUT_OF_SERVICE_AREA", outOfServiceAreaMessage(), 400);
  }
  if (reservationRequired() && !existing.slotReservationId) {
    throw serviceError("RESERVATION_MISSING", "This visit has no reserved slot. Pick a time and save first.", 409);
  }
  const before = bookingSnapshot(existing);

  let eligibility = null;
  await runReservationTransaction(async (session) => {
    await acquireFreeVisitLock(session);
    const booking = await Booking.findById(bookingId).session(session);
    if (!isPendingFreeVisit(booking)) throw serviceError("NOT_PENDING", "This visit was changed while you were confirming it.", 409);
    const owner = await User.findById(booking.user).select("_id phone email").session(session).lean();
    const addressKey = addressMatchKey({ line1: booking.address, city: booking.city, state: booking.state, zip: booking.zip });
    eligibility = await checkFreeVisitEligibility(
      { phone: owner?.phone || booking.phone, email: owner?.email || booking.email, address: addressKey, userId: booking.user },
      {
        session,
        excludeBookingId: booking._id,
        excludeAccountAddress: booking.addressId ? { userId: booking.user, addressId: booking.addressId } : null,
      }
    );
    if (eligibility.decision === "blocked") {
      throw serviceError(eligibility.code, "This customer has already used or booked a free visit.", 409, { eligibility });
    }
    if (eligibility.decision === "review" && !acknowledgeReview) {
      throw serviceError("REVIEW_REQUIRED", "Possible repeat customer: verify, then confirm again.", 409, { eligibility });
    }

    const now = new Date();
    booking.statusHistory = (booking.statusHistory || []).concat({ status: booking.status, date: now });
    booking.status = "Confirmed";
    booking.freeVisitReview = {
      ...reviewFrom(eligibility, now),
      acknowledgedAt: eligibility.decision === "review" ? now : null,
      acknowledgedBy: eligibility.decision === "review" ? actorUser?._id || null : null,
    };
    booking.freeVisitConfirmation = {
      ...(booking.freeVisitConfirmation?.toObject?.() || {}),
      confirmedAt: now,
      confirmedBy: actorUser?._id || null,
      notifyClaimedAt: null,
    };
    resetBookingReminderEmailStateForDateChange(booking, booking.date);
    await booking.save({ session });
  });

  const booking = await Booking.findById(bookingId);
  await logBookingChanges({ bookingId: booking._id, before, after: bookingSnapshot(booking), req });
  const notified = await notifyConfirmedOnce(booking._id);
  return { booking, alreadyConfirmed: false, notified, eligibility };
}

/**
 * The customer's confirmed-appointment email and text, and the crew's copy.
 * Claimed with one conditional write, so a retried or double-clicked Confirm
 * (or two Admin tabs) sends them once.
 */
async function notifyConfirmedOnce(bookingId) {
  const claimed = await Booking.findOneAndUpdate(
    { _id: bookingId, status: /^confirmed$/i, "freeVisitConfirmation.notifyClaimedAt": null },
    { $set: { "freeVisitConfirmation.notifyClaimedAt": new Date() } },
    { new: true }
  );
  if (!claimed) return false;
  const user = claimed.user ? await User.findById(claimed.user).lean() : null;
  const address = addressLine(claimed);

  try {
    await mail.sendTx(
      "booking_confirmed",
      claimed.email,
      {
        name: claimed.name || String(claimed.email || "").split("@")[0],
        bookingNumber: claimed.bookingNumber,
        date: claimed.date,
        service: claimed.service,
        selectedTask: claimed.selectedTask,
        bookingType: claimed.bookingType,
        accessType: claimed.accessType,
        address,
      },
      {
        bccAdmin: false,
        logContext: {
          bookingId: claimed._id,
          bookingNumber: claimed.bookingNumber,
          customerName: claimed.name || "",
          customerEmail: claimed.email || "",
          recipientName: claimed.name || "",
          recipientEmail: claimed.email || "",
          emailType: "transactional",
          source: "freeVisitConfirm",
        },
      }
    );
  } catch (error) {
    console.error("free visit confirmation email failed", { bookingId: String(claimed._id), message: error.message });
  }

  await smsNotify.notifyBookingConfirmed(claimed, user, "freeVisitConfirm");

  try {
    await generalFixterNotify.bookingCreated(mail, {
      bookingId: claimed._id,
      bookingNumber: claimed.bookingNumber,
      customerName: claimed.name || "",
      customerEmail: claimed.email || "",
      phone: claimed.phone || "",
      date: claimed.date,
      service: claimed.service,
      // The crew must know whether to bring tools: a Free Visit from 2026-10-30 is a to-do-list review.
      bookingType: claimed.freeVisitPurpose === "consultation" ? "Free Visit (to-do list review, no labor)" : "Free first visit",
      address,
      note: [
        claimed.libraryReference ? `Job type (Profixter example): ${libraryLabel(claimed.libraryReference)}` : "",
        claimed.note || "",
      ]
        .filter(Boolean)
        .join("\n"),
      source: "freeVisitConfirm",
    });
  } catch (error) {
    console.log("General Fixter free visit notify error:", error.message);
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 4. Decline / cancel                                                  */
/* ------------------------------------------------------------------ */

/**
 * Release the slot now and close the lead. The free visit is not used: the
 * booking ends Canceled, which every eligibility rule reads as released.
 */
async function declineGuestVisit({ bookingId, actorUser = null, reason = "", kind = "declined" }) {
  const booking = await Booking.findById(bookingId);
  if (!isReviewableFreeVisit(booking)) throw serviceError("NOT_A_GUEST_VISIT", "This is not a free-visit request.", 404);
  const status = String(booking.status || "").toLowerCase();
  if (["canceled", "cancelled"].includes(status)) {
    await syncLeadFromBooking(booking.toObject());
    return { booking, alreadyClosed: true };
  }
  if (["completed", "complete", "done"].includes(status)) {
    throw serviceError("ALREADY_COMPLETED", "A completed visit cannot be declined.", 409);
  }
  const online = isOnlineFreeVisit(booking);
  let result;
  if (booking.slotReservationId || reservationRequired()) {
    result = await cancelBookingWithReservation({
      bookingId: booking._id,
      actorUser,
      createdByType: "admin",
      reason: kind === "declined" ? "Free visit request declined by Admin" : "Free visit canceled by Admin",
    });
  } else {
    booking.statusHistory = (booking.statusHistory || []).concat({ status: booking.status, date: new Date() });
    booking.status = "Canceled";
    await booking.save();
    result = { booking };
  }
  // The account's per-address offer goes back with it: a declined visit is not a used one.
  if (online && booking.addressId) {
    await releaseIntroVisitClaim({ UserModel: User, userId: booking.user, addressId: booking.addressId }).catch((error) =>
      console.error("free visit decline: intro claim release failed", { bookingId: String(booking._id), message: error.message })
    );
  }
  const updated = await Booking.findOneAndUpdate(
    { _id: booking._id },
    {
      $set: {
        "freeVisitConfirmation.declinedAt": kind === "declined" ? new Date() : null,
        "freeVisitConfirmation.declineReason": cleanText(reason, 300),
      },
    },
    { new: true }
  );
  await syncLeadFromBooking(updated.toObject());
  if (online) await notifyOnlineDeclined(updated);
  return { booking: updated || result.booking, alreadyClosed: false };
}

/*
 * An online customer was told "booked, awaiting confirmation", so a decline is
 * news they must get. Email only, with the existing cancellation template: no
 * new text message type, and an owner who wants to explain will call anyway.
 * Reached once per visit: an already-closed visit returns before this.
 */
async function notifyOnlineDeclined(booking) {
  if (!booking?.email) return;
  try {
    await mail.sendTx(
      "booking_canceled",
      booking.email,
      {
        name: booking.name || String(booking.email).split("@")[0],
        bookingNumber: booking.bookingNumber,
        date: booking.date,
        service: booking.service,
        address: addressLine(booking),
      },
      {
        bccAdmin: false,
        logContext: {
          bookingId: booking._id,
          bookingNumber: booking.bookingNumber,
          customerName: booking.name || "",
          customerEmail: booking.email || "",
          recipientName: booking.name || "",
          recipientEmail: booking.email,
          emailType: "transactional",
          source: "freeVisitDecline",
        },
      }
    );
  } catch (error) {
    console.error("free visit decline email failed", { bookingId: String(booking._id), message: error.message });
  }
}

/* ------------------------------------------------------------------ */
/* 5. Older requests (made before requests reserved slots)              */
/* ------------------------------------------------------------------ */

/**
 * Give each still-pending, still-future request from the first day of the guest
 * flow the reservation it would get today. Idempotent: a request is linked in
 * the same transaction that reserves its slot, and only if still unlinked. A
 * slot already gone, or a person who already has a free visit, is recorded on
 * the lead for the owner instead - nothing is double-booked or consumed.
 */
async function backfillUnlinkedGuestRequests({ now = new Date(), logger = console } = {}) {
  const pending = await Request.find({
    serviceType: "free_visit_request",
    status: "pending_confirmation",
    $or: [{ bookingId: null }, { bookingId: { $exists: false } }],
    requestedAt: { $gt: now },
    "reservationIssue.code": { $in: ["", null] },
  }).limit(50);
  const summary = { checked: pending.length, reserved: 0, flagged: 0 };
  for (const request of pending) {
    try {
      await reserveGuestFreeVisit({
        request,
        existingRequest: true,
        slotStart: request.requestedAt,
        bookingData: {
          name: request.name,
          phone: request.phone,
          email: request.email,
          note: request.message,
          images: request.images || [],
          libraryReference: request.libraryReference || "",
          guestContactConsent: {
            text: request.contactConsent?.text || "",
            at: request.contactConsent?.at || null,
            ip: request.contactConsent?.ip || "",
          },
        },
      });
      summary.reserved += 1;
    } catch (error) {
      if (error?.code === "REQUEST_ALREADY_LINKED") continue;
      summary.flagged += 1;
      await Request.updateOne(
        { _id: request._id },
        {
          $set: {
            reservationIssue: {
              code: error?.code || "RESERVATION_FAILED",
              message:
                error?.code === "SLOT_UNAVAILABLE"
                  ? "The requested time was already taken when slots started being reserved. Call to pick another time."
                  : String(error?.message || "Could not reserve this request.").slice(0, 300),
              at: new Date(),
            },
          },
        }
      );
    }
  }
  if (summary.checked) logger.log("free_visit_request_backfill", JSON.stringify(summary));
  return summary;
}

module.exports = {
  PENDING,
  channelOf,
  isOnlineFreeVisit,
  isPendingFreeVisit,
  isReviewableFreeVisit,
  backfillUnlinkedGuestRequests,
  confirmGuestVisit,
  declineGuestVisit,
  hasValidAddress,
  isPendingGuest,
  leadStatusFor,
  notifyConfirmedOnce,
  readAddress,
  reserveGuestFreeVisit,
  syncLeadFromBooking,
  updateGuestVisit,
};
