/**
 * First Visit Free — acquisition eligibility.
 *
 * The introductory visit is tracked on the address subdocument, NOT on the
 * Booking document, so booking lifecycle operations (cancel, delete, cleanup)
 * can never accidentally reset a consumed offer.
 *
 * States:
 *   available  - property has not consumed the introductory visit
 *   claimed    - an introductory visit is currently booked
 *   consumed   - the introductory visit was actually completed (permanent)
 *
 * Transitions are reconciled lazily, on read, by inspecting the claimed
 * booking's own durable fields. Nothing in this module ever writes to a
 * Booking. Member booking, calendar, availability and scheduling behavior are
 * untouched.
 */

const INTRO_VISIT_STATUS = {
  AVAILABLE: "available",
  CLAIMED: "claimed",
  CONSUMED: "consumed",
};

/** Service value the free introductory visit is restricted to. */
const INTRO_VISIT_SERVICE = "Labor Only";

/** Visit length, mirroring the reservation engine's VISIT_DURATION_MINUTES. */
const INTRO_VISIT_DURATION_MINUTES = 90;

function normalizeStatus(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
}

/** Booking statuses that mean the service actually happened. */
const COMPLETED_STATUSES = new Set(["completed", "complete", "done"]);

/** Booking statuses that mean the visit will not happen and never did. */
const RELEASED_STATUSES = new Set(["canceled", "cancelled"]);

/**
 * Decide what a claimed offer should become, given the booking it points at.
 *
 * Pure function - no database access - so the state machine is unit testable.
 *
 * Conservative by design: anything we do not positively recognize as
 * "cancelled before service" leaves the offer claimed. We would rather a
 * customer contact us than hand out repeat free labor automatically.
 *
 * @param {{status?: string, completedAt?: Date|null}|null} booking
 * @returns {"available"|"claimed"|"consumed"}
 */
function resolveClaimedState(booking) {
  // Booking row is gone. Under the reservation engine (production) bookings are
  // preserved, so this is unexpected. Stay claimed rather than release.
  if (!booking) return INTRO_VISIT_STATUS.CLAIMED;

  // completedAt is written by the single completion path and is the most
  // durable signal available.
  if (booking.completedAt) return INTRO_VISIT_STATUS.CONSUMED;

  const status = normalizeStatus(booking.status);
  if (COMPLETED_STATUSES.has(status)) return INTRO_VISIT_STATUS.CONSUMED;

  // Cancelled before service - the customer never received the visit, so the
  // offer returns to them.
  if (RELEASED_STATUSES.has(status)) return INTRO_VISIT_STATUS.AVAILABLE;

  // Pending / Confirmed / anything unrecognized (no-show, failed) stays
  // claimed. Admin can reset it manually if a customer needs it back.
  return INTRO_VISIT_STATUS.CLAIMED;
}

/**
 * Derive the starting state for an address that predates this feature.
 *
 * Reproduces the legacy rule exactly - "has this address ever booked a free
 * first visit?" - so existing accounts keep the behavior they already had.
 * Nothing is written in bulk; each address is derived once, on first read.
 */
async function deriveLegacyState(Booking, userId, addressId) {
  const legacyBooking = await Booking.findOne({
    user: userId,
    addressId,
    isFreeFirstVisit: true,
  })
    .sort({ createdAt: -1 })
    .select("status completedAt")
    .lean();

  if (!legacyBooking) {
    return { status: INTRO_VISIT_STATUS.AVAILABLE, bookingId: null };
  }

  return {
    status: resolveClaimedState(legacyBooking),
    bookingId: legacyBooking._id || null,
  };
}

/**
 * Read the current introductory-visit state for an address, reconciling it
 * against the claimed booking if there is one.
 *
 * Persists the reconciled state when it changes, so the record converges and
 * later reads are cheap. Returns the state plus a convenience `isAvailable`.
 *
 * @param {object} params
 * @param {object} params.user       Mongoose User document (not lean)
 * @param {object} params.address    Address subdocument from user.addresses
 * @param {object} params.Booking    Booking model
 * @param {boolean} [params.persist] Save the user document if state changed
 */
async function getIntroVisitState({ user, address, Booking, persist = true }) {
  if (!user || !address) {
    return { status: INTRO_VISIT_STATUS.CONSUMED, isAvailable: false, changed: false };
  }

  let record = address.introVisit;
  let changed = false;

  // First time we have looked at this address - derive from booking history so
  // pre-existing accounts are neither wrongly granted nor wrongly denied.
  if (!record || !record.status) {
    const derived = await deriveLegacyState(Booking, user._id, address._id);
    address.introVisit = {
      status: derived.status,
      bookingId: derived.bookingId,
      claimedAt: derived.status === INTRO_VISIT_STATUS.AVAILABLE ? null : new Date(),
      consumedAt: derived.status === INTRO_VISIT_STATUS.CONSUMED ? new Date() : null,
    };
    record = address.introVisit;
    changed = true;
  } else if (record.status === INTRO_VISIT_STATUS.CLAIMED) {
    // Reconcile an outstanding claim against its booking.
    const booking = record.bookingId
      ? await Booking.findById(record.bookingId).select("status completedAt").lean()
      : null;

    const next = resolveClaimedState(booking);

    if (next !== record.status) {
      record.status = next;
      if (next === INTRO_VISIT_STATUS.CONSUMED) {
        record.consumedAt = booking?.completedAt || new Date();
      }
      if (next === INTRO_VISIT_STATUS.AVAILABLE) {
        // Release the claim but keep claimedAt history for operational review.
        record.bookingId = null;
      }
      changed = true;
    }
  }

  if (changed && persist) {
    await user.save();
  }

  return {
    status: record.status,
    isAvailable: record.status === INTRO_VISIT_STATUS.AVAILABLE,
    bookingId: record.bookingId || null,
    changed,
  };
}

/**
 * Mark the introductory visit as claimed by a specific booking.
 * Called immediately after a free booking is created.
 *
 * Prefer claimIntroVisitAtomic for the booking path - this variant does not
 * serialize concurrent requests.
 */
async function claimIntroVisit({ user, address, bookingId, persist = true }) {
  if (!user || !address) return false;

  address.introVisit = {
    status: INTRO_VISIT_STATUS.CLAIMED,
    bookingId: bookingId || null,
    claimedAt: new Date(),
    consumedAt: address.introVisit?.consumedAt || null,
  };

  if (persist) await user.save();
  return true;
}

/**
 * Atomically claim the introductory offer for one address.
 *
 * The filter only matches when the offer is still available, so MongoDB's
 * single-document atomicity guarantees exactly one concurrent request wins.
 * This is what closes the double-claim race: the offer is reserved BEFORE the
 * booking is created, not after.
 *
 * Returns true if this caller won the claim, false if someone else already had
 * it (or it is consumed).
 */
async function claimIntroVisitAtomic({ UserModel, userId, addressId }) {
  if (!UserModel || !userId || !addressId) return false;

  const now = new Date();
  const result = await UserModel.updateOne(
    {
      _id: userId,
      addresses: {
        $elemMatch: {
          _id: addressId,
          $or: [
            { "introVisit.status": { $exists: false } },
            { "introVisit.status": null },
            { "introVisit.status": INTRO_VISIT_STATUS.AVAILABLE },
          ],
        },
      },
    },
    {
      $set: {
        "addresses.$.introVisit.status": INTRO_VISIT_STATUS.CLAIMED,
        "addresses.$.introVisit.bookingId": null,
        "addresses.$.introVisit.claimedAt": now,
      },
    }
  );

  return result.modifiedCount === 1;
}

/**
 * Attach the created booking to an already-claimed offer.
 * Only writes when the address is still claimed, so a concurrent release or
 * completion cannot be overwritten.
 */
async function attachBookingToClaim({ UserModel, userId, addressId, bookingId }) {
  if (!UserModel || !userId || !addressId || !bookingId) return false;

  const result = await UserModel.updateOne(
    {
      _id: userId,
      addresses: {
        $elemMatch: { _id: addressId, "introVisit.status": INTRO_VISIT_STATUS.CLAIMED },
      },
    },
    { $set: { "addresses.$.introVisit.bookingId": bookingId } }
  );

  return result.modifiedCount === 1;
}

/**
 * Release a claim back to available.
 *
 * Used when booking creation fails after the claim succeeded, so a customer is
 * never left holding an offer they could not actually book. Never releases a
 * consumed offer - the filter requires the claimed state.
 */
async function releaseIntroVisitClaim({ UserModel, userId, addressId }) {
  if (!UserModel || !userId || !addressId) return false;

  const result = await UserModel.updateOne(
    {
      _id: userId,
      addresses: {
        $elemMatch: { _id: addressId, "introVisit.status": INTRO_VISIT_STATUS.CLAIMED },
      },
    },
    {
      $set: {
        "addresses.$.introVisit.status": INTRO_VISIT_STATUS.AVAILABLE,
        "addresses.$.introVisit.bookingId": null,
      },
    }
  );

  return result.modifiedCount === 1;
}

/* ------------------------------------------------------------------ */
/* Address normalization - conservative duplicate protection           */
/* ------------------------------------------------------------------ */

const STREET_SUFFIXES = new Map([
  ["street", "st"], ["str", "st"], ["st", "st"],
  ["avenue", "ave"], ["av", "ave"], ["ave", "ave"],
  ["road", "rd"], ["rd", "rd"],
  ["drive", "dr"], ["dr", "dr"],
  ["lane", "ln"], ["ln", "ln"],
  ["boulevard", "blvd"], ["blvd", "blvd"],
  ["court", "ct"], ["ct", "ct"],
  ["place", "pl"], ["pl", "pl"],
  ["terrace", "ter"], ["ter", "ter"],
  ["circle", "cir"], ["cir", "cir"],
  ["highway", "hwy"], ["hwy", "hwy"],
  ["parkway", "pkwy"], ["pkwy", "pkwy"],
  ["north", "n"], ["south", "s"], ["east", "e"], ["west", "w"],
]);

/** Tokens that introduce a unit/apartment identifier. */
const UNIT_TOKENS = new Set(["apt", "apartment", "unit", "ste", "suite", "#", "no", "num"]);

/**
 * Build a comparison key for an address.
 *
 * Deliberately conservative. Unit identifiers are preserved and normalized to a
 * canonical `unit <value>` token, so "123 Main St Apt 1" and "123 Main St Apt 2"
 * produce different keys and are never merged. An address with no unit is also
 * distinct from one with a unit.
 *
 * Returns "" when required parts are missing, which callers treat as
 * "cannot compare" rather than "matches everything".
 */
function buildAddressKey(addr) {
  const line1 = String(addr?.line1 || "").trim();
  const city = String(addr?.city || "").trim();
  const state = String(addr?.state || "").trim();
  const zip = String(addr?.zip || "").trim();

  if (!line1 || !zip) return "";

  const rawTokens = line1
    .toLowerCase()
    .replace(/[.,]/g, " ")
    .replace(/#/g, " # ")
    .split(/\s+/)
    .filter(Boolean);

  const streetParts = [];
  const unitParts = [];
  let inUnit = false;

  for (const token of rawTokens) {
    if (UNIT_TOKENS.has(token)) {
      inUnit = true;
      continue;
    }
    if (inUnit) {
      unitParts.push(token);
      continue;
    }
    streetParts.push(STREET_SUFFIXES.get(token) || token);
  }

  const street = streetParts.join(" ").trim();
  const unit = unitParts.join(" ").trim();

  const normalizedZip = zip.split("-")[0].trim();

  return [
    street,
    unit ? `unit ${unit}` : "",
    city.toLowerCase(),
    state.toLowerCase(),
    normalizedZip,
  ]
    .filter(Boolean)
    .join("|");
}

/**
 * Find an existing address on the user that refers to the same property.
 * Returns the matching subdocument, or null.
 */
function findDuplicateAddress(user, candidate) {
  const key = buildAddressKey(candidate);
  if (!key) return null;

  return (
    (user?.addresses || []).find((existing) => buildAddressKey(existing) === key) || null
  );
}

module.exports = {
  INTRO_VISIT_STATUS,
  INTRO_VISIT_SERVICE,
  INTRO_VISIT_DURATION_MINUTES,
  resolveClaimedState,
  getIntroVisitState,
  claimIntroVisit,
  claimIntroVisitAtomic,
  attachBookingToClaim,
  releaseIntroVisitClaim,
  buildAddressKey,
  findDuplicateAddress,
};
