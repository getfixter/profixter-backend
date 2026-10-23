/**
 * ONE free visit per person, for life, across guest requests and accounts.
 *
 * Both ways of getting a free visit - the homepage request (no account) and the
 * signed-in booker - ask this module, on the server, at the moment of the
 * claim. It looks at every free visit ever recorded, whichever way it came in:
 *
 *   - Bookings flagged as free visits, guest or account, in any status;
 *   - account addresses whose introVisit is claimed or consumed (older history
 *     that may no longer have its booking);
 *   - homepage requests that never got a booking (the first day of the guest
 *     flow, before requests reserved slots).
 *
 * IDENTITY. A person is matched by account, phone (E.164), email (canonical)
 * and service address (street, unit, ZIP). Never by name. Matches are graded:
 *
 *   strong  - same account, same email, or same phone that nothing contradicts.
 *   review  - same phone but a different email and nothing else in common (a
 *             recycled number), or the same address and nothing else (a shared
 *             house, a new owner). The owner decides; the server neither
 *             grants nor refuses on that alone.
 *
 * WHAT A MATCHED VISIT MEANS (the existing business rules, unchanged):
 *   completed                  -> lifetime eligibility consumed;
 *   pending / confirmed / any
 *   unrecognised status, incl.
 *   no-show                    -> a free visit is already claimed (no-show
 *                                 stays claimed until an admin releases it,
 *                                 exactly as introVisitEligibility does);
 *   canceled / declined        -> released, does not count.
 *
 * CONCURRENCY. A check is a read. acquireFreeVisitLock writes one shared
 * document inside the caller's transaction, so two claims for one person
 * cannot both pass; see models/FreeVisitLock.
 */
const Booking = require("../../models/Booking");
const User = require("../../models/User");
const Request = require("../../models/Request");
const FreeVisitLock = require("../../models/FreeVisitLock");
const { normalizePhoneE164 } = require("../identity");
const { buildAddressKey } = require("../introVisitEligibility");

const STATE = { CONSUMED: "consumed", ACTIVE: "active", RELEASED: "released" };

const COMPLETED = new Set(["completed", "complete", "done"]);
const RELEASED = new Set(["canceled", "cancelled", "declined"]);

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s_]+/g, " ");
}

/** Lowercase, no "+tag"; Gmail ignores dots, so those go too. */
function canonicalEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1) return "";
  let local = email.slice(0, at).split("+")[0];
  let domain = email.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local && domain ? `${local}@${domain}` : "";
}

function canonicalPhone(value) {
  return normalizePhoneE164(value) || "";
}

/*
 * street|unit|zip. buildAddressKey already normalises suffixes and units; the
 * city is dropped because the same house is written "Massapequa" on one record
 * and "Massapequa Park" on another, while its ZIP does not change.
 */
function addressMatchKey(address) {
  if (!address) return "";
  const key = buildAddressKey({
    line1: [address.line1 || address.address || "", address.unit ? `unit ${address.unit}` : ""].filter(Boolean).join(" "),
    city: address.city || "",
    state: address.state || "",
    zip: address.zip || "",
  });
  if (!key) return "";
  const parts = key.split("|");
  const street = parts[0];
  const unit = parts.find((p) => p.startsWith("unit ")) || "";
  const zip = parts[parts.length - 1];
  return [street, unit, zip].filter(Boolean).join("|");
}

function identityOf({ phone, email, address, userId } = {}) {
  return {
    phone: canonicalPhone(phone),
    email: canonicalEmail(email),
    addressKey: typeof address === "string" ? address : addressMatchKey(address),
    userId: userId ? String(userId) : "",
  };
}

function stateOfBooking(booking) {
  if (booking.completedAt) return STATE.CONSUMED;
  const status = normalizeStatus(booking.status);
  if (COMPLETED.has(status)) return STATE.CONSUMED;
  if (RELEASED.has(status)) return STATE.RELEASED;
  return STATE.ACTIVE;
}

function stateOfRequest(request) {
  const status = normalizeStatus(request.status);
  if (status === "completed") return STATE.CONSUMED;
  if (["lost", "declined", "canceled", "cancelled"].includes(status)) return STATE.RELEASED;
  return STATE.ACTIVE;
}

/**
 * Every free visit on record, as plain identity rows. `session` makes the read
 * part of the caller's transaction snapshot.
 */
async function loadFreeVisitHistory({ session = null, excludeBookingId = null, excludeRequestId = null, excludeAccountAddress = null } = {}) {
  const withSession = (q) => (session ? q.session(session) : q);
  const [bookings, users, requests] = await Promise.all([
    withSession(
      Booking.find({
        $or: [{ isFreeFirstVisit: true }, { accessType: "free_first_visit" }, { guestRequestId: { $ne: null } }],
      }).select(
        "_id bookingNumber user userId name phone email address city state zip status completedAt date guestRequestId freeVisitIdentity isFreeFirstVisit accessType"
      )
    ).lean(),
    withSession(
      User.find({ "addresses.introVisit.status": { $in: ["claimed", "consumed"] } }).select("_id userId email phone addresses")
    ).lean(),
    withSession(
      Request.find({ serviceType: "free_visit_request", $or: [{ bookingId: null }, { bookingId: { $exists: false } }] }).select(
        "_id name phone email status requestedAt createdAt"
      )
    ).lean(),
  ]);

  const rows = [];
  const bookingIds = new Set();
  const usersByObjectId = new Map(users.map((u) => [String(u._id), u]));

  for (const b of bookings) {
    if (excludeBookingId && String(b._id) === String(excludeBookingId)) continue;
    if (excludeRequestId && b.guestRequestId && String(b.guestRequestId) === String(excludeRequestId)) continue;
    // A guest request that is not yet a free visit (no flag) still claims one.
    if (!b.isFreeFirstVisit && b.accessType !== "free_first_visit" && !b.guestRequestId) continue;
    bookingIds.add(String(b._id));
    const frozen = b.freeVisitIdentity || {};
    const owner = b.user ? usersByObjectId.get(String(b.user)) : null;
    rows.push({
      source: "booking",
      bookingId: String(b._id),
      bookingNumber: b.bookingNumber || "",
      requestId: b.guestRequestId ? String(b.guestRequestId) : "",
      state: stateOfBooking(b),
      status: b.status || "",
      date: b.date || null,
      userId: String(frozen.userId || b.user || ""),
      // The frozen identity first; the booking's own copy as well, because a
      // booking made before identities were frozen only has that.
      phones: [frozen.phone, canonicalPhone(b.phone), canonicalPhone(owner?.phone)].filter(Boolean),
      emails: [frozen.email, canonicalEmail(b.email), canonicalEmail(owner?.email)].filter(Boolean),
      addressKeys: [frozen.addressKey, addressMatchKey({ line1: b.address, city: b.city, state: b.state, zip: b.zip })].filter(Boolean),
    });
  }

  for (const u of users) {
    for (const a of u.addresses || []) {
      const intro = a.introVisit || {};
      if (!["claimed", "consumed"].includes(intro.status)) continue;
      // Its booking is already a row above, with the more precise state.
      if (intro.bookingId && bookingIds.has(String(intro.bookingId))) continue;
      if (excludeBookingId && intro.bookingId && String(intro.bookingId) === String(excludeBookingId)) continue;
      // The claim the caller itself just made, for the booking it is creating.
      if (
        excludeAccountAddress &&
        String(u._id) === String(excludeAccountAddress.userId) &&
        String(a._id) === String(excludeAccountAddress.addressId) &&
        !intro.bookingId
      ) continue;
      rows.push({
        source: "account_address",
        bookingId: intro.bookingId ? String(intro.bookingId) : "",
        bookingNumber: "",
        requestId: "",
        state: intro.status === "consumed" ? STATE.CONSUMED : STATE.ACTIVE,
        status: intro.status,
        date: intro.claimedAt || null,
        userId: String(u._id),
        phones: [canonicalPhone(u.phone)].filter(Boolean),
        emails: [canonicalEmail(u.email)].filter(Boolean),
        addressKeys: [addressMatchKey(a)].filter(Boolean),
      });
    }
  }

  for (const r of requests) {
    if (excludeRequestId && String(r._id) === String(excludeRequestId)) continue;
    rows.push({
      source: "request",
      bookingId: "",
      bookingNumber: "",
      requestId: String(r._id),
      state: stateOfRequest(r),
      status: r.status || "",
      date: r.requestedAt || r.createdAt || null,
      userId: "",
      phones: [canonicalPhone(r.phone)].filter(Boolean),
      emails: [canonicalEmail(r.email)].filter(Boolean),
      addressKeys: [],
    });
  }
  return rows;
}

/**
 * The decision, from identity and history alone. Pure, so every rule above is
 * tested without a database.
 *
 * @returns {{decision: "eligible"|"blocked"|"review", code: string, reasons: string[], matches: object[]}}
 */
function evaluateFreeVisitEligibility(identity, history) {
  const matches = [];
  for (const row of history) {
    if (row.state === STATE.RELEASED) continue;
    const on = [];
    if (identity.userId && row.userId && identity.userId === row.userId) on.push("account");
    if (identity.phone && row.phones.includes(identity.phone)) on.push("phone");
    if (identity.email && row.emails.includes(identity.email)) on.push("email");
    if (identity.addressKey && row.addressKeys.includes(identity.addressKey)) on.push("address");
    if (!on.length) continue;

    const emailContradicts =
      identity.email && row.emails.length && !row.emails.includes(identity.email);
    let strength;
    if (on.includes("account") || on.includes("email")) strength = "strong";
    else if (on.includes("phone") && (on.includes("address") || !emailContradicts)) strength = "strong";
    else strength = "review";

    matches.push({
      source: row.source,
      bookingId: row.bookingId,
      bookingNumber: row.bookingNumber,
      requestId: row.requestId,
      state: row.state,
      status: row.status,
      date: row.date,
      matchedOn: on,
      strength,
    });
  }

  const strong = matches.filter((m) => m.strength === "strong");
  if (strong.some((m) => m.state === STATE.CONSUMED)) {
    return { decision: "blocked", code: "FREE_VISIT_USED", reasons: ["completed_free_visit"], matches };
  }
  if (strong.some((m) => m.state === STATE.ACTIVE)) {
    return { decision: "blocked", code: "FREE_VISIT_ACTIVE", reasons: ["free_visit_already_booked"], matches };
  }
  const review = matches.filter((m) => m.strength === "review");
  if (review.length) {
    const reasons = new Set();
    for (const m of review) {
      if (m.matchedOn.includes("phone")) reasons.add("same_phone_different_email");
      if (m.matchedOn.includes("address") && !m.matchedOn.includes("phone")) reasons.add("same_address_different_person");
    }
    return { decision: "review", code: "FREE_VISIT_REVIEW", reasons: [...reasons], matches };
  }
  return { decision: "eligible", code: "", reasons: [], matches };
}

async function checkFreeVisitEligibility(identityInput, options = {}) {
  const identity = identityOf(identityInput);
  const history = await loadFreeVisitHistory(options);
  return { identity, ...evaluateFreeVisitEligibility(identity, history) };
}

/** Write the shared lock inside `session`; see the header. */
async function acquireFreeVisitLock(session) {
  await FreeVisitLock.updateOne(
    { _id: "free_visit" },
    { $inc: { seq: 1 }, $set: { lastAt: new Date() } },
    { upsert: true, session }
  );
}

/* What a customer reads, for each refusal. Calm, and always a way forward. */
const CUSTOMER_MESSAGES = {
  FREE_VISIT_USED:
    "Our records show the free first visit has already been used. Call or text 631-599-1363 and we'll help you book your next visit.",
  FREE_VISIT_ACTIVE:
    "You already have a free visit booked or requested with us. We'll be in touch shortly - or call or text 631-599-1363 to change it.",
};

function blockedError(result) {
  const error = new Error(CUSTOMER_MESSAGES[result.code] || "This free visit is not available.");
  error.code = result.code;
  error.statusCode = 403;
  error.eligibility = result;
  return error;
}

module.exports = {
  STATE,
  CUSTOMER_MESSAGES,
  acquireFreeVisitLock,
  addressMatchKey,
  blockedError,
  canonicalEmail,
  canonicalPhone,
  checkFreeVisitEligibility,
  evaluateFreeVisitEligibility,
  identityOf,
  loadFreeVisitHistory,
};
