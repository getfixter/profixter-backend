// routes/users.js — final
const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const User = require("../models/User");
const Subscription = require("../models/Subscription");
const Booking = require("../models/Booking");
const auth = require("../middleware/auth");
const {
  subscriptionGrantsAccess,
  verifySubscriptionAccess,
} = require("../utils/subscriptionManagement");
const { findDuplicateAddress } = require("../utils/introVisitEligibility");
const { toE164 } = require("../utils/sms/smsPhone");
// The eligibility layer's own reading of an opt-out row, reused rather than
// reimplemented so the account screen and the send path cannot disagree.
const { optOutFor } = require("../utils/sms/smsEligibility");

async function subscriptionBlocksDestructiveAction(subscription, source) {
  if (!subscription) return false;
  if (!subscription.stripeSubscriptionId) {
    return subscriptionGrantsAccess(subscription);
  }

  const verification = await verifySubscriptionAccess(subscription, { source });
  // Account/address deletion should fail closed during a Stripe outage.
  return verification.error ? true : verification.grantsAccess;
}

/* Helpers */
function normalizeAddressInput(body = {}) {
  const line1  = String(body.line1 || body.address || "").trim();
  const city   = String(body.city || "").trim();
  const state  = String((body.state || "NY")).trim();
  const zip    = String(body.zip || "").trim();
  const county = String(body.county || "").trim();
  const label  = String(body.label || body.name || "Address").trim() || "Address";
  return { label, line1, city, state, zip, county };
}
function validateAddressFields(a) {
  const errs = [];
  if (!a.line1) errs.push("line1");
  if (!a.city)  errs.push("city");
  if (!a.state) errs.push("state");
  if (!a.zip)   errs.push("zip");
  if (!a.county) errs.push("county");
  return errs;
}

function toAddressDTO(subdoc) {
  return {
    _id: String(subdoc._id),
    label: subdoc.label,
    line1: subdoc.line1,
    city:  subdoc.city,
    state: subdoc.state,
    zip:   subdoc.zip,
    county: subdoc.county || "",
  };
}

/** 🔧 If user has NO sub-addresses but has legacy fields, create a Primary and set default */
async function ensurePrimaryFromLegacy(user) {
  if (!user) return false;
  const hasSubs = Array.isArray(user.addresses) && user.addresses.length > 0;
  const legacyComplete = [user.address, user.city, user.state, user.zip]
    .every(v => !!(v && String(v).trim()));
  if (hasSubs || !legacyComplete) return false;

  user.addresses.push({
    label: "Primary",
    line1: String(user.address).trim(),
    city:  String(user.city).trim(),
    state: String(user.state || "NY").trim(),
    zip:   String(user.zip).trim(),
    county: String(user.county || "").trim(),
  });
  user.defaultAddressId = user.addresses[user.addresses.length - 1]._id;
  await user.save();
  return true;
}

/* ───────── ROUTES ───────── */

// Get my addresses (auto-hydrate from legacy if needed)
router.get("/me/addresses", auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    await ensurePrimaryFromLegacy(me);

    const list = (me.addresses || []).map(toAddressDTO);
    const defaultId = me.defaultAddressId ? String(me.defaultAddressId) : null;
    return res.json({ addresses: list, defaultAddressId: defaultId });
  } catch (e) {
    console.error("GET /me/addresses error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

/* ─────────────── Marketing SMS preference (account settings) ───────────────
 *
 * The opt-in that signup collects, for everybody who registered before it
 * existed. Without this, marketing consent could only ever accrue from new
 * accounts and every current customer would be permanently unreachable on the
 * channel - not because they declined, but because they were never asked.
 *
 * MARKETING ONLY. THIS TOUCHES NOTHING ELSE.
 *
 * Not transactional messaging: service texts about a visit somebody booked
 * rest on a different basis and are switched off with STOP, not here. Not
 * SmsOptOut: that is keyed to the handset rather than the account and is the
 * carrier-level answer. Not GHL, not email marketing, not gift SMS - each has
 * its own consent and its own switch, and collapsing any of them into this one
 * checkbox is how a preference screen quietly becomes a liability.
 */

/**
 * The phone-level opt-out standing against this account's number, if any.
 *
 * Read through the same optOutFor the eligibility layer uses rather than
 * querying SmsOptOut directly, so a START that resolved an earlier STOP is
 * interpreted here exactly as it is at send time. Two readings of the same row
 * that disagree would show a customer a checkbox that silently does nothing.
 */
async function phoneOptOutFor(user) {
  const e164 = toE164(user?.phone);
  if (!e164) return { phone: null, optOut: null };
  return { phone: e164, optOut: await optOutFor(e164) };
}

function smsPreferenceDTO(user, optOut) {
  const prefs = user?.smsPreferences || {};
  return {
    // Absent means off. Nobody is opted in by default, and a missing field is
    // "never asked" rather than a quiet yes.
    marketingEnabled: prefs.marketingEnabled === true,
    marketingConsentAt: prefs.marketingConsentAt || null,
    marketingConsentSource: prefs.marketingConsentSource || "",
    /*
     * The handset-level state, surfaced so the UI can explain itself.
     *
     * A number under a STOP cannot receive anything, so showing an ordinary
     * checkbox there would be offering a choice we are not able to honour.
     */
    phoneOptedOut: Boolean(optOut),
    phoneOptOutScope: optOut?.scope || "",
  };
}

router.get("/me/sms-preferences", auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id).select("phone smsPreferences");
    if (!me) return res.status(404).json({ message: "User not found" });

    const { optOut } = await phoneOptOutFor(me);
    return res.json(smsPreferenceDTO(me, optOut));
  } catch (e) {
    console.error("GET /me/sms-preferences error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

router.put("/me/sms-preferences", auth, async (req, res) => {
  try {
    /*
     * The literal boolean, or nothing.
     *
     * Same rule the register route applies: a string is always truthy, so
     * accepting anything looser would let "false" opt somebody in.
     */
    const marketingEnabled = req.body?.marketingEnabled;
    if (marketingEnabled !== true && marketingEnabled !== false) {
      return res.status(400).json({ message: "marketingEnabled must be true or false" });
    }

    const me = await User.findById(req.user.id).select("phone smsPreferences");
    if (!me) return res.status(404).json({ message: "User not found" });

    const { optOut } = await phoneOptOutFor(me);

    /*
     * A STOP on the handset outranks anything chosen here, and the refusal is
     * explicit rather than a silent no-op.
     *
     * The customer texted STOP to a carrier-registered number; only a START
     * from that same handset undoes it. Letting an account screen quietly flip
     * the preference back on would leave our database claiming a consent
     * Twilio would refuse to act on - and clearing the SmsOptOut row from here
     * would be worse still, because it would erase the record of a withdrawal
     * we are legally required to honour.
     *
     * Only opting IN is blocked. Somebody under a STOP who wants marketing off
     * in their account as well is agreeing with us, and that is allowed
     * through below.
     */
    if (marketingEnabled === true && optOut) {
      return res.status(409).json({
        message:
          "This phone number has opted out of SMS. Text START to re-enable messages before turning marketing texts on.",
        ...smsPreferenceDTO(me, optOut),
      });
    }

    /*
     * Turning it on records WHEN and HOW, because those are the half of a
     * consent record that answers a dispute. Turning it off sets only the flag:
     * this is a marketing preference, not a STOP, so it must not touch
     * optedOutAt or optOutSource - those mirror the handset-level withdrawal
     * and are the webhook's to write - and it must not touch
     * transactionalEnabled, so visit reminders keep working.
     *
     * The consent timestamp is deliberately left in place on the way out. It
     * is the historical fact that consent was once given, which stays true
     * after it is withdrawn, and marketingEnabled=false is what eligibility
     * actually reads.
     */
    const update = marketingEnabled
      ? {
          "smsPreferences.marketingEnabled": true,
          "smsPreferences.marketingConsentAt": new Date(),
          "smsPreferences.marketingConsentSource": "account_settings",
        }
      : { "smsPreferences.marketingEnabled": false };

    await User.updateOne({ _id: me._id }, { $set: update });

    const fresh = await User.findById(me._id).select("phone smsPreferences");
    console.log(
      JSON.stringify({
        event: "sms_marketing_preference_changed",
        userId: String(me._id),
        marketingEnabled,
        source: "account_settings",
      })
    );
    return res.json(smsPreferenceDTO(fresh, optOut));
  } catch (e) {
    console.error("PUT /me/sms-preferences error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Add a new address
router.post("/addresses", auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    const addr = normalizeAddressInput(req.body);
    const errs = validateAddressFields(addr);
    if (errs.length) {
      return res.status(400).json({ message: "Missing fields", fields: errs });
    }

    // Conservative duplicate protection. Unit/apartment identifiers are
    // preserved, so "Apt 1" and "Apt 2" remain distinct properties. Returning
    // the existing record keeps its acquisition state intact rather than
    // minting a fresh introductory-visit eligibility.
    const duplicate = findDuplicateAddress(me, addr);
    if (duplicate) {
      return res.status(200).json({
        address: toAddressDTO(duplicate),
        defaultAddressId: me.defaultAddressId ? String(me.defaultAddressId) : null,
        deduplicated: true,
      });
    }

    me.addresses.push(addr);
    if (!me.defaultAddressId) {
      me.defaultAddressId = me.addresses[me.addresses.length - 1]._id;
    }
    await me.save();

    const created = me.addresses[me.addresses.length - 1];
    return res.status(201).json({
      address: toAddressDTO(created),
      defaultAddressId: me.defaultAddressId ? String(me.defaultAddressId) : null,
    });
  } catch (e) {
    console.error("POST /addresses error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Alias: GET /api/users/addresses  → same as /me/addresses
router.get("/addresses", auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });
    const list = (me.addresses || []).map(toAddressDTO);
    const defaultId = me.defaultAddressId ? String(me.defaultAddressId) : null;
    return res.json({ addresses: list, defaultAddressId: defaultId });
  } catch (e) {
    console.error("GET /addresses alias error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Alias: PATCH /api/users/addresses/:id/default  → same as /default-address/:id
router.patch("/addresses/:addressId/default", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });
    const exists = me.addresses.id(addressId);
    if (!exists) return res.status(404).json({ message: "Address not found" });
    me.defaultAddressId = addressId;
    await me.save();
    return res.json({ ok: true, defaultAddressId: String(me.defaultAddressId) });
  } catch (e) {
    console.error("PATCH /addresses/:id/default alias error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Update an address (DISABLED - addresses cannot be edited)
router.patch("/addresses/:addressId", auth, async (req, res) => {
  return res.status(403).json({
    message: "Editing addresses is disabled. Delete the address and add a new one instead.",
  });
});


// Delete an address (guarded)
router.delete("/addresses/:addressId", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    const subdoc = me.addresses.id(addressId);
    if (!subdoc) return res.status(404).json({ message: "Address not found" });

    if (String(me.defaultAddressId) === String(addressId) && (me.addresses?.length || 0) <= 1) {
      return res.status(400).json({ message: "Cannot delete the only address on the account" });
    }

const activeSubCandidate = await Subscription.findOne({
  user: me._id,
  addressId,
  status: { $in: ["active", "trialing"] },
});
const activeSub = await subscriptionBlocksDestructiveAction(
  activeSubCandidate,
  "address_delete_guard"
)
  ? activeSubCandidate
  : null;
    if (activeSub) {
      return res.status(400).json({ message: "This address has an active subscription. Cancel or move the subscription first." });
    }

const isDeletingDefault = me.defaultAddressId && String(me.defaultAddressId) === String(addressId);

// ✅ Addressless active Subscription doc blocks deleting default address
if (!activeSub && isDeletingDefault) {
  const addrlessCandidate = await Subscription.findOne({
    user: me._id,
    addressId: { $in: [null, undefined] },
    status: { $in: ["active", "trialing"] },
  });
  const addrless = await subscriptionBlocksDestructiveAction(
    addrlessCandidate,
    "address_delete_guard"
  )
    ? addrlessCandidate
    : null;

  if (addrless) {
    return res.status(400).json({
      message: "This default address is tied to an active subscription. Cancel the subscription first.",
    });
  }
}


    const now = new Date();
    const futureBooking = await Booking.findOne({
      user: me._id,
      addressId,
      date: { $gte: now },
      status: { $nin: ["Canceled"] },
    });
    if (futureBooking) {
      return res.status(400).json({ message: "This address has a future booking. Cancel that booking first." });
    }

    subdoc.remove();
    if (String(me.defaultAddressId) === String(addressId)) {
      me.defaultAddressId = me.addresses[0]?._id || null;
    }
    await me.save();

    return res.json({
      ok: true,
      defaultAddressId: me.defaultAddressId ? String(me.defaultAddressId) : null,
      addresses: (me.addresses || []).map(toAddressDTO),
    });
  } catch (e) {
    console.error("DELETE /addresses/:id error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

// Delete account (self-service — blocked if active subscription exists)
router.delete("/me", auth, async (req, res) => {
  try {
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    const activeCandidates = await Subscription.find({
      user: me._id,
      status: { $in: ["active", "trialing"] },
    });
    let activeSub = null;
    for (const subscription of activeCandidates) {
      if (await subscriptionBlocksDestructiveAction(subscription, "account_delete_guard")) {
        activeSub = subscription;
        break;
      }
    }

    if (activeSub) {
      return res.status(400).json({
        message:
          "You have an active subscription. Please cancel it in the My Plan tab before deleting your account.",
        code: "ACTIVE_SUBSCRIPTION",
      });
    }

    await User.findByIdAndDelete(me._id);

    return res.json({ ok: true, message: "Account deleted." });
  } catch (e) {
    console.error("DELETE /me error:", e);
    return res.status(500).json({ message: "Server error. Please try again." });
  }
});

// Set default
router.patch("/default-address/:addressId", auth, async (req, res) => {
  try {
    const { addressId } = req.params;
    if (!mongoose.isValidObjectId(addressId)) {
      return res.status(400).json({ message: "Invalid addressId" });
    }
    const me = await User.findById(req.user.id);
    if (!me) return res.status(404).json({ message: "User not found" });

    const exists = me.addresses.id(addressId);
    if (!exists) return res.status(404).json({ message: "Address not found" });

    me.defaultAddressId = addressId;
    await me.save();

    return res.json({ ok: true, defaultAddressId: String(me.defaultAddressId) });
  } catch (e) {
    console.error("PATCH /default-address/:id error:", e);
    return res.status(500).json({ message: "Server error" });
  }
});

module.exports = router;
