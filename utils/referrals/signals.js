/**
 * Review flags for a referral reward. They only ever FLAG: the owner decides,
 * with a note, before a flagged reward can be approved. The two hard rules
 * (the referrer's own account, a customer who already had a paid membership)
 * are decided in engine.js and never reach a flag.
 *
 * Same person or household as the referrer:
 *   same_email, same_phone       normalised (utils/sales/selfReferral)
 *   same_address                 any home on one account matches a home on the other
 *   same_stripe_customer         the same Stripe customer paid
 *   same_card                    the card that paid is one the referrer's Stripe customer holds
 * Not a new household:
 *   household_member             another account at the referred home already had a membership
 *   household_rewarded           another referral reward was already earned for that home
 *   card_rewarded                the card that paid already earned another referral reward
 * Worth a look:
 *   existing_account             the account existed well before the referral was recorded
 *   earlier_gift                 the referred account had a gifted membership before
 *   chargeback                   a chargeback on a counted payment
 *   tax_form (info)              the referrer's checks this year reach $600 (W-9 / 1099)
 */
const User = require("../../models/User");
const Subscription = require("../../models/Subscription");
const { normEmail, normPhone, sameAddress } = require("../sales/selfReferral");
const { dollars } = require("./amounts");

const EXISTING_ACCOUNT_MS = 3 * 24 * 60 * 60 * 1000;
const TAX_FORM_CENTS = 60000;

const TEXT = {
  same_email: "The friend's email is the referrer's own email.",
  same_phone: "The friend's phone number is the referrer's own number.",
  same_address: "The friend's home matches one of the referrer's homes. This is usually the same household, which does not qualify.",
  same_stripe_customer: "The same Stripe customer paid for both accounts.",
  same_card: "The card that paid for the friend's membership is saved on the referrer's Stripe account.",
  household_member: "Another account at the friend's home already had a Profixter membership, so this may not be a new household.",
  household_rewarded: "A referral reward was already earned for another account at the friend's home.",
  card_rewarded: "The card that paid already paid for another referred membership that earned a reward.",
  existing_account: "The friend's account existed before the referral was recorded. Check that the referrer really brought them in.",
  earlier_gift: "The friend had a gifted membership before. Check that they are new to Profixter memberships.",
  chargeback: "A chargeback was opened on one of the counted payments.",
};

const flag = (code, strength, text = TEXT[code]) => ({ code, strength, text, at: new Date() });

/** Cards saved on a Stripe customer (fingerprints only). Best effort, never throws. */
async function customerCardFingerprints(stripe, customerId) {
  if (!stripe || !customerId) return [];
  try {
    const list = await stripe.paymentMethods.list({ customer: String(customerId), type: "card", limit: 20 });
    return (list?.data || []).map((pm) => pm?.card?.fingerprint).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Every flag for this referral as things stand now. `referral` is the record
 * (with first/second filled in when known). Never throws.
 */
async function flagsFor(referral, { stripe = null, now = new Date() } = {}) {
  const { CustomerReferral } = require("../../models/ReferralProgram");
  const out = [];
  try {
    const [referrer, referred] = await Promise.all([
      User.findById(referral.referrer).select("email phone addresses stripeCustomerId").lean(),
      User.findById(referral.referred).select("email phone addresses stripeCustomerId createdAt").lean(),
    ]);
    if (!referrer || !referred) return out;

    const e1 = normEmail(referrer.email);
    if (e1 && e1 === normEmail(referred.email)) out.push(flag("same_email", "same_person"));
    const p1 = normPhone(referrer.phone);
    if (p1 && p1 === normPhone(referred.phone)) out.push(flag("same_phone", "same_person"));
    if ((referred.addresses || []).some((a) => (referrer.addresses || []).some((b) => sameAddress(a, b)))) out.push(flag("same_address", "household"));
    if (referrer.stripeCustomerId && referred.stripeCustomerId && String(referrer.stripeCustomerId) === String(referred.stripeCustomerId)) {
      out.push(flag("same_stripe_customer", "same_person"));
    }

    const fingerprints = [referral.first?.cardFingerprint, referral.second?.cardFingerprint].filter(Boolean);
    if (fingerprints.length && referrer.stripeCustomerId) {
      const theirs = await customerCardFingerprints(stripe, referrer.stripeCustomerId);
      if (fingerprints.some((f) => theirs.includes(f))) out.push(flag("same_card", "payment"));
    }

    /*
     * Not a new household: another account at the same home that had a
     * membership, or earned a reward, BEFORE this friend's first payment. Only
     * earlier ones: the first household to join is the new one, and a
     * neighbour joining later must not flag it after the fact.
     */
    const asOf = referral.first?.paidAt ? new Date(referral.first.paidAt) : now;
    const homes = referred.addresses || [];
    if (homes.length) {
      const zips = [...new Set(homes.map((a) => String(a.zip || "").slice(0, 5)).filter(Boolean))];
      if (zips.length) {
        const neighbours = await User.find({ _id: { $nin: [referred._id] }, "addresses.zip": { $in: zips } })
          .select("_id addresses")
          .limit(500)
          .lean();
        const sameHome = neighbours.filter((n) => (n.addresses || []).some((a) => homes.some((h) => sameAddress(a, h)))).map((n) => n._id);
        const others = sameHome.filter((id) => String(id) !== String(referrer._id));
        if (others.length) {
          const hadMembership = await Subscription.exists({ user: { $in: others }, stripeSubscriptionId: { $nin: [null, ""] }, createdAt: { $lt: asOf } });
          if (hadMembership) out.push(flag("household_member", "household"));
          const rewarded = await CustomerReferral.exists({
            _id: { $ne: referral._id },
            referred: { $in: others },
            status: { $in: ["pending", "eligible", "approved", "mailed"] },
            "first.paidAt": { $lt: asOf },
          });
          if (rewarded) out.push(flag("household_rewarded", "household"));
        }
      }
    }

    if (fingerprints.length) {
      const sameCard = await CustomerReferral.exists({
        _id: { $ne: referral._id },
        status: { $in: ["pending", "eligible", "approved", "mailed"] },
        "first.paidAt": { $lt: asOf },
        $or: [{ "first.cardFingerprint": { $in: fingerprints } }, { "second.cardFingerprint": { $in: fingerprints } }],
      });
      if (sameCard) out.push(flag("card_rewarded", "payment"));
    }

    const recordedAt = referral.createdAt ? new Date(referral.createdAt) : now;
    if (referred.createdAt && recordedAt - new Date(referred.createdAt) > EXISTING_ACCOUNT_MS) out.push(flag("existing_account", "review"));

    const gift = await require("../../models/GiftMembership").exists({ recipient: referred._id, status: "claimed" }).catch(() => null);
    if (gift) out.push(flag("earlier_gift", "review"));

    if (referral.first?.disputed || referral.second?.disputed) out.push(flag("chargeback", "payment"));

    // Information only: never blocks approval.
    if (referral.amountCents > 0) {
      const year = new Date(now.getFullYear(), 0, 1);
      const rows = await CustomerReferral.find({
        _id: { $ne: referral._id },
        referrer: referral.referrer,
        status: { $in: ["approved", "mailed"] },
        $or: [{ "check.mailedAt": { $gte: year } }, { "approval.at": { $gte: year } }],
      })
        .select("amountCents approval")
        .lean();
      const total = rows.reduce((s, r) => s + (Number(r.approval?.amountCents || r.amountCents) || 0), 0) + referral.amountCents;
      if (total >= TAX_FORM_CENTS) {
        out.push(flag("tax_form", "info", `With this check, the referrer's referral checks this year come to ${dollars(total)}. Payments of $600 or more in a year usually need a W-9 and a 1099. Check with your accountant.`));
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ area: "referrals", event: "flags_failed", referralId: String(referral?._id || ""), message: String(error?.message || error).slice(0, 200) }));
  }
  return out;
}

/** Flags the owner must look at before approving (everything except information). */
const blockingFlags = (flags) => (flags || []).filter((f) => f.strength !== "info");

/** Has the owner cleared every blocking flag currently on the record? */
function flagsCleared(referral) {
  const seen = new Set(referral?.flagsReview?.codes || []);
  return blockingFlags(referral?.flags).every((f) => seen.has(f.code));
}

module.exports = { flagsFor, blockingFlags, flagsCleared, TEXT };
