/**
 * The referral program's rules, in one place.
 *
 * ATTRIBUTION (bindReferral)
 *   A friend opens /r/<code>; the browser keeps the code and sends it when an
 *   account is created, when a signed-in customer opens the site, and with the
 *   membership checkout. The FIRST referral recorded for an account wins and
 *   is never replaced. Refused outright: the referrer's own account, a staff
 *   account, a customer who already had a paid membership.
 *
 * REWARD (Stripe webhook → onInvoicePaid / onChargeRefunded / onDispute)
 *   first paid membership invoice   → Pending, amount = lesser of $149 and the
 *                                      membership amount actually collected on
 *                                      it (utils/referrals/amounts)
 *   second paid membership invoice  → Eligible (ready for the owner)
 *   a refund on the first invoice   → amount recomputed; refunded in full → Void
 *   a full refund on the second     → back to Pending, waiting for another paid month
 *   a chargeback                    → flagged for the owner
 *   after approval or mailing, any of these → the owner's attention, never a silent change
 * Every update is keyed by Stripe ids and cumulative values, so a duplicate or
 * replayed webhook changes nothing. These hooks never throw into the webhook.
 *
 * PAYOUT (owner, routes/adminReferrals)
 *   Eligible → (flags cleared, payee confirmed, fresh recheck against Stripe,
 *   amount unchanged) Approved → (fresh recheck again, check reference) Mailed.
 *   The owner writes and mails the check; nothing here moves money.
 */
const User = require("../../models/User");
const Subscription = require("../../models/Subscription");
const { CustomerReferral } = require("../../models/ReferralProgram");
const { resolveCode, isCustomerAccount } = require("./codes");
const A = require("./amounts");
const { flagsFor, flagsCleared, blockingFlags } = require("./signals");

const stripeClient = () => require("../subscriptionManagement").stripe;
const notify = () => require("./notify");

function log(level, event, details = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), area: "referrals", event, ...details });
  if (level === "error") console.error(line);
  else console.log(line);
}

class ReferralError extends Error {
  constructor(code, message, status = 400, extra = {}) {
    super(message);
    this.code = code;
    this.status = status;
    Object.assign(this, extra);
  }
}

const OPEN_STATUSES = ["attributed", "pending", "eligible", "approved"];

function historyPush(doc, event, detail = "", by = "system") {
  doc.history.push({ at: new Date(), event, by, detail: String(detail).slice(0, 500) });
}

/** Save with a retry when another webhook changed the record first (optimistic concurrency). */
async function mutate(id, fn, { attempts = 4 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const doc = await CustomerReferral.findById(id);
    if (!doc) return null;
    const changed = await fn(doc);
    if (changed === false) return doc;
    try {
      await doc.save();
      return doc;
    } catch (error) {
      if (error?.name !== "VersionError" || i === attempts - 1) throw error;
    }
  }
  return null;
}

/** Has this account had a paid membership already (other than `exceptSubscriptionId`)? */
async function hadPaidMembership(userId, exceptSubscriptionId = null) {
  const ids = [null, "", ...(exceptSubscriptionId ? [String(exceptSubscriptionId)] : [])];
  return Boolean(await Subscription.exists({ user: userId, stripeSubscriptionId: { $nin: ids } }));
}

function clampCapturedAt(value, now) {
  const t = value ? new Date(value) : null;
  if (!t || Number.isNaN(t.getTime())) return null;
  if (t > now || now - t > 365 * 24 * 60 * 60 * 1000) return null;
  return t;
}

/* ------------------------------------------------------------------ attribution */

/**
 * Record that `user` was referred with `code`. Returns { ok, reason, referral }.
 * reason: recorded | already_referred | unknown_code | self | not_customer | already_member | no_code
 */
async function bindReferral({ user, code, via = "claim", capturedAt = null, exceptSubscriptionId = null, now = new Date() }) {
  try {
    if (!code) return { ok: false, reason: "no_code" };
    const account = user?._id ? user : null;
    if (!account) return { ok: false, reason: "no_account" };
    const existing = await CustomerReferral.findOne({ referred: account._id }).lean();
    if (existing) return { ok: existing.code === String(code).toLowerCase() || existing.code === String(code), reason: "already_referred", referral: existing };
    const found = await resolveCode(code);
    if (!found) return { ok: false, reason: "unknown_code" };
    if (String(found.referrer._id) === String(account._id)) return { ok: false, reason: "self" };
    const fresh = account.role === undefined ? await User.findById(account._id).select("role employeePosition").lean() : account;
    if (!isCustomerAccount(fresh)) return { ok: false, reason: "not_customer" };
    if (await hadPaidMembership(account._id, exceptSubscriptionId)) return { ok: false, reason: "already_member" };
    try {
      const referral = await CustomerReferral.create({
        referrer: found.referrer._id,
        referred: account._id,
        code: found.code,
        via: found.legacy && via === "legacy_accept" ? "legacy_accept" : via,
        capturedAt: clampCapturedAt(capturedAt, now),
        status: "attributed",
        history: [{ at: now, event: "attributed", by: "system", detail: `Referred through ${found.legacy ? "an older referral link" : "a personal link"} (${via}).` }],
      });
      log("info", "referral_attributed", { referralId: String(referral._id), via });
      return { ok: true, reason: "recorded", referral: referral.toObject() };
    } catch (error) {
      if (error?.code === 11000) {
        const raced = await CustomerReferral.findOne({ referred: account._id }).lean();
        return { ok: Boolean(raced && raced.code === found.code), reason: "already_referred", referral: raced };
      }
      throw error;
    }
  } catch (error) {
    log("error", "bind_failed", { message: String(error?.message || error).slice(0, 200) });
    return { ok: false, reason: "error" };
  }
}

/** The referral a request carries ({ referral: { code, capturedAt } }, or a bare code). */
function referralFromBody(body) {
  const r = body?.referral;
  if (!r) return null;
  if (typeof r === "string") return { code: r.slice(0, 200), capturedAt: null };
  if (typeof r === "object" && r.code) return { code: String(r.code).slice(0, 200), capturedAt: r.capturedAt || r.at || null };
  return null;
}

/** At account creation, from any sign-up route. Never throws. */
async function bindFromRequest(user, req, via = "signup") {
  const r = referralFromBody(req?.body);
  if (!r) return null;
  return bindReferral({ user, code: r.code, capturedAt: r.capturedAt, via });
}

/* ------------------------------------------------------------------ Stripe */

async function cardFingerprintOf(invoice) {
  const read = (ch) => (ch && typeof ch === "object" ? ch.payment_method_details?.card?.fingerprint || null : null);
  try {
    if (read(invoice.charge)) return read(invoice.charge);
    const stripe = stripeClient();
    const chargeId = A.idOf(invoice.charge);
    if (chargeId) return read(await stripe.charges.retrieve(chargeId));
    const piId = A.idOf(invoice.payment_intent);
    if (piId) {
      const pi = await stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge"] });
      return read(pi?.latest_charge);
    }
  } catch (error) {
    log("warn", "card_fingerprint_failed", { invoiceId: invoice?.id, message: String(error?.message || error).slice(0, 160) });
  }
  return null;
}

async function refreshFlags(doc) {
  const before = new Set((doc.flags || []).map((f) => f.code));
  const next = await flagsFor(doc, { stripe: stripeClient() });
  // Keep the time a flag was first raised.
  const old = new Map((doc.flags || []).map((f) => [f.code, f]));
  doc.flags = next.map((f) => (old.has(f.code) ? { ...f, at: old.get(f.code).at } : f));
  return next.filter((f) => !before.has(f.code));
}

function setAmount(doc) {
  const amount = A.rewardCents(doc.first);
  const changed = amount !== doc.amountCents;
  doc.amountCents = amount;
  return changed;
}

/** invoice.paid on a membership (called from routes/webhook handleInvoicePaid). Never throws. */
async function onInvoicePaid({ invoice, stripeSubscription = null, subscription = null }) {
  try {
    if (!A.isCountedInvoice(invoice) || !subscription?.user) return null;
    let found = await CustomerReferral.findOne({ referred: subscription.user }).select("_id").lean();
    if (!found) {
      // The checkout carried a referral the account never recorded (for example, the claim failed): record it now.
      const code = stripeSubscription?.metadata?.referralCode;
      if (!code) return null;
      const user = await User.findById(subscription.user).lean();
      const bound = await bindReferral({ user, code, via: "checkout", exceptSubscriptionId: A.idOf(invoice.subscription) });
      if (!bound.ok || !bound.referral) return null;
      found = bound.referral;
    }
    const plan = String(subscription.subscriptionType || stripeSubscription?.metadata?.plan || "").toLowerCase() || null;
    const cycle = subscription.billingCycle === "annual" ? "annual" : "monthly";
    let notifyPending = false;
    let notifyReady = false;
    const doc = await mutate(found._id, async (d) => {
      if (d.first?.invoiceId === invoice.id || d.second?.invoiceId === invoice.id) return false; // a replay
      if (d.status === "attributed") {
        if (await hadPaidMembership(d.referred, A.idOf(invoice.subscription))) {
          d.status = "not_eligible";
          d.reason = "The friend already had a Profixter membership.";
          historyPush(d, "not_eligible", d.reason);
          return true;
        }
        d.first = A.invoiceRecord(invoice, { plan, cycle, cardFingerprint: await cardFingerprintOf(invoice) });
        setAmount(d);
        d.status = "pending";
        historyPush(d, "pending", `First paid membership invoice ${invoice.id}: ${A.dollars(d.first.paidPreTaxCents)} before tax${d.first.promoCode ? `, promotion code ${d.first.promoCode}` : ""}. Reward ${A.dollars(d.amountCents)}.`);
        await refreshFlags(d);
        notifyPending = true;
        return true;
      }
      if (d.status === "pending" && d.first?.invoiceId) {
        const rec = A.invoiceRecord(invoice, { plan, cycle, cardFingerprint: await cardFingerprintOf(invoice) });
        if (rec.paidAt < d.first.paidAt) {
          // Delivered out of order: the earlier invoice is the first one.
          d.second = d.first;
          d.first = rec;
          setAmount(d);
        } else if (!d.second?.invoiceId || !A.secondCleared(d.second)) {
          d.second = rec;
        } else {
          return false;
        }
        historyPush(d, "second_payment", `Second paid membership invoice ${d.second.invoiceId}.`);
        if (A.secondCleared(d.second) && d.amountCents > 0) {
          d.status = "eligible";
          historyPush(d, "eligible", `Ready: ${A.dollars(d.amountCents)}.`);
          await refreshFlags(d);
          notifyReady = true;
        }
        return true;
      }
      return false; // eligible and after: later renewals change nothing
    });
    if (doc && notifyPending) await notify().referrerPending(doc);
    if (doc && notifyReady) await Promise.all([notify().referrerReady(doc), notify().ownerReady(doc)]);
    return doc;
  } catch (error) {
    log("error", "invoice_paid_failed", { invoiceId: invoice?.id, message: String(error?.message || error).slice(0, 300) });
    return null;
  }
}

async function referralForCharge({ chargeId, invoiceId }) {
  const or = [];
  if (chargeId) or.push({ "first.chargeId": chargeId }, { "second.chargeId": chargeId });
  if (invoiceId) or.push({ "first.invoiceId": invoiceId }, { "second.invoiceId": invoiceId });
  if (!or.length) return null;
  return CustomerReferral.findOne({ $or: or }).select("_id").lean();
}

/** After approval the record never changes silently: the owner is told instead. */
function afterApprovalProblem(d, text) {
  if (d.status === "approved") {
    d.status = "eligible";
    d.approval = { at: null, by: null, amountCents: 0 };
    d.attention = `${text} The approval was withdrawn: recheck and approve again.`;
    historyPush(d, "approval_withdrawn", text);
    return true;
  }
  if (d.status === "mailed") {
    d.attention = `${text} The check was already mailed.`;
    historyPush(d, "attention", text);
    return true;
  }
  return false;
}

/** Apply a charge's current state (refund total, dispute) to whichever counted invoice it paid. */
function applyChargeState(d, { chargeId, invoiceId, refundedCents = null, disputed = null }) {
  const which = [d.first, d.second].findIndex((x) => x && ((chargeId && x.chargeId === chargeId) || (invoiceId && x.invoiceId === invoiceId)));
  if (which < 0) return { changed: false };
  const key = which === 0 ? "first" : "second";
  const before = d[key];
  let rec = { ...(before.toObject ? before.toObject() : before) };
  if (refundedCents !== null) rec = A.withRefund(rec, refundedCents);
  if (disputed !== null) rec.disputed = Boolean(disputed);
  if (rec.refundedCents === before.refundedCents && rec.disputed === before.disputed) return { changed: false };
  d[key] = rec;
  return { changed: true, key, rec, before };
}

/** Status after the first/second invoice changed. Returns a short description for the history and the owner. */
function settle(d, key) {
  const was = d.status;
  if (key === "first") {
    const before = d.amountCents;
    setAmount(d);
    if (d.amountCents === before) return ""; // a chargeback alone: flagged, the caller tells the owner
    if (d.amountCents <= 0) {
      const text = d.first.disputed ? "A chargeback on the friend's first membership payment." : "The friend's first membership payment was refunded in full.";
      if (["attributed", "pending", "eligible"].includes(was)) {
        d.status = "void";
        d.reason = text;
        historyPush(d, "void", text);
        return text;
      }
      afterApprovalProblem(d, text);
      return text;
    }
    const text = `The reward changed from ${A.dollars(before)} to ${A.dollars(d.amountCents)} after a refund on the first payment.`;
    historyPush(d, "amount_changed", text);
    afterApprovalProblem(d, text);
    return text;
  }
  if (!A.secondCleared(d.second)) {
    const text = d.second.disputed ? "A chargeback on the friend's second membership payment." : "The friend's second membership payment was refunded in full.";
    if (was === "eligible") {
      d.status = "pending";
      historyPush(d, "pending", `${text} Waiting for another paid month.`);
    } else if (was === "approved") {
      afterApprovalProblem(d, text);
      d.status = "pending";
    } else if (was === "mailed") {
      afterApprovalProblem(d, text);
    }
    return text;
  }
  return "";
}

/** charge.refunded (any charge; ignores everything that did not pay a counted invoice). Never throws. */
async function onChargeRefunded(charge) {
  try {
    if (!charge?.id) return null;
    const invoiceId = A.idOf(charge.invoice);
    const found = await referralForCharge({ chargeId: charge.id, invoiceId });
    if (!found) return null;
    let problem = "";
    let statusAfter = "";
    let statusBefore = "";
    const doc = await mutate(found._id, async (d) => {
      statusBefore = d.status;
      const { changed, key } = applyChargeState(d, { chargeId: charge.id, invoiceId, refundedCents: Number(charge.amount_refunded || 0) });
      if (!changed) return false; // a replayed refund event: the cumulative total is unchanged
      historyPush(d, "refund", `${A.dollars(charge.amount_refunded)} refunded in total on the ${key} payment (${charge.id}).`);
      problem = settle(d, key);
      if (key === "first" || key === "second") await refreshFlags(d);
      statusAfter = d.status;
      return true;
    });
    if (doc && problem && (["approved", "mailed"].includes(statusBefore) || statusAfter !== statusBefore)) await notify().ownerAttention(doc, problem);
    return doc;
  } catch (error) {
    log("error", "refund_failed", { chargeId: charge?.id, message: String(error?.message || error).slice(0, 300) });
    return null;
  }
}

/** charge.dispute.created / .closed. A lost chargeback counts as a full refund. Never throws. */
async function onDispute(dispute, phase = "opened") {
  try {
    const chargeId = A.idOf(dispute?.charge);
    if (!chargeId) return null;
    const found = await referralForCharge({ chargeId });
    if (!found) return null;
    let problem = "";
    const doc = await mutate(found._id, async (d) => {
      const won = phase === "closed" && dispute.status === "won";
      const lost = phase === "closed" && dispute.status === "lost";
      const rec = [d.first, d.second].find((x) => x?.chargeId === chargeId);
      const patch = { chargeId, disputed: !won };
      if (lost && rec) patch.refundedCents = rec.amountPaidCents;
      const { changed, key } = applyChargeState(d, patch);
      if (!changed) return false;
      historyPush(d, "chargeback", `Chargeback ${phase}${phase === "closed" ? ` (${dispute.status})` : ""} on the ${key} payment.`);
      problem = settle(d, key) || (won ? "" : `A chargeback was opened on the friend's ${key} membership payment.`);
      if (!won && d.status === "approved") afterApprovalProblem(d, problem);
      await refreshFlags(d);
      return true;
    });
    if (doc && problem) await notify().ownerAttention(doc, problem);
    return doc;
  } catch (error) {
    log("error", "dispute_failed", { disputeId: dispute?.id, message: String(error?.message || error).slice(0, 300) });
    return null;
  }
}

/* ------------------------------------------------------------------ recheck */

/** Re-read one counted invoice and its charge from Stripe. */
async function readInvoiceFromStripe(rec) {
  const stripe = stripeClient();
  const invoice = await stripe.invoices.retrieve(rec.invoiceId);
  let fresh = A.invoiceRecord(invoice, { plan: rec.plan, cycle: rec.cycle, cardFingerprint: rec.cardFingerprint });
  const chargeId = fresh.chargeId || rec.chargeId;
  let charge = null;
  if (chargeId) charge = await stripe.charges.retrieve(chargeId);
  else if (fresh.paymentIntentId) {
    const pi = await stripe.paymentIntents.retrieve(fresh.paymentIntentId, { expand: ["latest_charge"] });
    charge = pi?.latest_charge && typeof pi.latest_charge === "object" ? pi.latest_charge : null;
  }
  if (charge) {
    fresh = A.withRefund({ ...fresh, chargeId: charge.id }, Number(charge.amount_refunded || 0));
    fresh.disputed = Boolean(charge.disputed);
  }
  return { fresh, paid: invoice.status === "paid" };
}

/**
 * Before a check is approved or mailed: every number again, from Stripe, now.
 * Returns { ok, changes: [text], referral }. Updates the record to match.
 */
async function recheck(id, { by = "owner" } = {}) {
  const changes = [];
  let doc = await mutate(id, async (d) => {
    changes.length = 0;
    if (!d.first?.invoiceId) {
      changes.push("No paid membership invoice is recorded yet.");
      return false;
    }
    const prevStatus = d.status;
    const first = await readInvoiceFromStripe(d.first);
    if (!first.paid) changes.push("Stripe no longer shows the first membership invoice as paid.");
    const prevAmount = d.amountCents;
    d.first = { ...first.fresh, cardFingerprint: d.first.cardFingerprint };
    setAmount(d);
    if (!first.paid) d.amountCents = 0;
    if (d.amountCents !== prevAmount) changes.push(`The reward is now ${A.dollars(d.amountCents)} (was ${A.dollars(prevAmount)}).`);
    if (d.first.disputed) changes.push("There is a chargeback on the first payment.");

    if (d.second?.invoiceId) {
      const second = await readInvoiceFromStripe(d.second);
      d.second = { ...second.fresh, cardFingerprint: d.second.cardFingerprint };
      if (!second.paid || !A.secondCleared(d.second)) changes.push("The second membership payment no longer counts (unpaid, refunded in full or disputed).");
    } else {
      changes.push("The second paid membership invoice has not arrived yet.");
    }

    const added = await refreshFlags(d);
    for (const f of blockingFlags(added)) changes.push(`New flag: ${f.text}`);

    if (["eligible", "approved"].includes(prevStatus)) {
      if (d.amountCents <= 0) {
        d.status = "void";
        d.reason = "Nothing left to reward after the recheck (refunded or unpaid).";
      } else if (!d.second?.invoiceId || !A.secondCleared(d.second)) {
        d.status = "pending";
      } else if (prevStatus === "approved" && (d.amountCents !== d.approval?.amountCents || added.some((f) => f.strength !== "info"))) {
        d.status = "eligible";
      }
      if (d.status !== "approved" && prevStatus === "approved") d.approval = { at: null, by: null, amountCents: 0 };
    }
    d.lastRecheck = { at: new Date(), ok: changes.length === 0, changes: [...changes] };
    historyPush(d, "recheck", changes.length ? changes.join(" ") : "Stripe matches: amount and both payments confirmed.", by);
    return true;
  });
  return { ok: changes.length === 0, changes: [...changes], referral: doc };
}

/* ------------------------------------------------------------------ owner actions */

async function load(id) {
  const doc = await CustomerReferral.findById(id);
  if (!doc) throw new ReferralError("NOT_FOUND", "Referral not found.", 404);
  return doc;
}

const clean = (v, max = 120) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function readPayee(body) {
  const p = {
    name: clean(body?.name, 100),
    line1: clean(body?.line1, 120),
    line2: clean(body?.line2, 80),
    city: clean(body?.city, 60),
    state: clean(body?.state, 2).toUpperCase(),
    zip: clean(body?.zip, 10),
  };
  if (p.name.length < 2) throw new ReferralError("PAYEE_NAME", "Enter the name the check should be made out to.");
  if (p.line1.length < 3 || !/\d/.test(p.line1)) throw new ReferralError("PAYEE_ADDRESS", "Enter the street address, with the house number.");
  if (p.city.length < 2) throw new ReferralError("PAYEE_CITY", "Enter the city.");
  if (!/^[A-Z]{2}$/.test(p.state)) throw new ReferralError("PAYEE_STATE", "Enter the two-letter state.");
  if (!/^\d{5}(-\d{4})?$/.test(p.zip)) throw new ReferralError("PAYEE_ZIP", "Enter a 5-digit ZIP code.");
  return p;
}

const PAYEE_STATUSES = ["pending", "eligible", "approved"];

/** The referrer (signed in, freshly confirmed) or the owner (after confirming with them) sets where the check goes. */
async function setPayee(id, body, { by, actor = "customer", note = "", actorUserId = null }) {
  const payee = readPayee(body);
  if (actor === "owner" && clean(note, 300).length < 3) throw new ReferralError("NOTE_REQUIRED", "Say how you confirmed the payee and address (for example, a phone call).");
  const doc = await mutate(id, async (d) => {
    if (actor === "customer" && String(d.referrer) !== String(actorUserId)) throw new ReferralError("NOT_FOUND", "Referral not found.", 404);
    if (!PAYEE_STATUSES.includes(d.status)) throw new ReferralError("CLOSED", "This reward can no longer be changed.", 409);
    const same = ["name", "line1", "line2", "city", "state", "zip"].every((k) => (d.payee?.[k] || "") === payee[k]);
    d.payee = { ...payee, confirmedAt: new Date(), confirmedBy: actor, note: actor === "owner" ? clean(note, 300) : "" };
    historyPush(d, "payee_confirmed", `${same ? "Mailing details reconfirmed" : "Mailing details set"} by the ${actor === "owner" ? "owner" : "referrer"}.${actor === "owner" ? ` ${clean(note, 300)}` : ""}`, by);
    if (d.status === "approved" && !same) {
      d.status = "eligible";
      d.approval = { at: null, by: null, amountCents: 0 };
      d.attention = "The mailing details changed after you approved this reward. Check them and approve again.";
    }
    return true;
  });
  return doc;
}

async function clearFlags(id, { note, byUserId, by }) {
  if (clean(note, 500).length < 3) throw new ReferralError("NOTE_REQUIRED", "Write what you checked.");
  return mutate(id, async (d) => {
    if (!OPEN_STATUSES.includes(d.status)) throw new ReferralError("CLOSED", "This reward is closed.", 409);
    const codes = blockingFlags(d.flags).map((f) => f.code);
    d.flagsReview = { clearedAt: new Date(), by: byUserId || null, note: clean(note, 500), codes };
    historyPush(d, "flags_cleared", `Checked: ${codes.join(", ") || "no flags"}. ${clean(note, 500)}`, by);
    return true;
  });
}

async function approve(id, { expectedAmountCents, payeeConfirmed, byUserId, by }) {
  const before = await load(id);
  if (before.status !== "eligible") throw new ReferralError("NOT_READY", "Only a reward that is ready can be approved.", 409);
  if (!before.payee?.confirmedAt) throw new ReferralError("PAYEE_MISSING", "Confirm the payee and mailing address first.", 409);
  if (payeeConfirmed !== true) throw new ReferralError("PAYEE_UNCONFIRMED", "Tick that you checked the payee and mailing address.", 400);
  const check = await recheck(id, { by });
  if (!check.ok) throw new ReferralError("RECHECK_CHANGED", "Stripe shows something different now. Review the changes before approving.", 409, { changes: check.changes, referral: check.referral });
  const doc = check.referral;
  if (!flagsCleared(doc)) throw new ReferralError("FLAGS_OPEN", "Review the flags and say what you checked first.", 409);
  if (Number(expectedAmountCents) !== doc.amountCents) throw new ReferralError("AMOUNT_CHANGED", `The reward is now ${A.dollars(doc.amountCents)}. Check it and approve again.`, 409, { referral: doc });
  return mutate(id, async (d) => {
    if (d.status !== "eligible") throw new ReferralError("NOT_READY", "Only a reward that is ready can be approved.", 409);
    d.status = "approved";
    d.approval = { at: new Date(), by: byUserId || null, amountCents: d.amountCents };
    d.attention = "";
    historyPush(d, "approved", `Approved ${A.dollars(d.amountCents)}, payable to ${d.payee.name}.`, by);
    return true;
  });
}

async function markMailed(id, { reference, mailedAt, note, byUserId, by }) {
  const ref = clean(reference, 60);
  if (ref.length < 1) throw new ReferralError("REFERENCE_REQUIRED", "Enter the check number or reference.");
  const when = mailedAt ? new Date(mailedAt) : new Date();
  if (Number.isNaN(when.getTime()) || when > new Date(Date.now() + 24 * 3600 * 1000)) throw new ReferralError("MAILED_AT", "Enter the date the check was mailed.");
  const before = await load(id);
  if (before.status !== "approved") throw new ReferralError("NOT_APPROVED", "Approve the reward before marking the check mailed.", 409);
  const check = await recheck(id, { by });
  if (!check.ok || check.referral.status !== "approved") {
    throw new ReferralError("RECHECK_CHANGED", "Stripe shows something different now, so the approval was withdrawn. Review before mailing.", 409, { changes: check.changes, referral: check.referral });
  }
  const doc = await mutate(id, async (d) => {
    if (d.status !== "approved") throw new ReferralError("NOT_APPROVED", "Approve the reward before marking the check mailed.", 409);
    d.status = "mailed";
    d.check = { reference: ref, mailedAt: when, by: byUserId || null, note: clean(note, 300) };
    d.attention = "";
    historyPush(d, "mailed", `Check ${ref} for ${A.dollars(d.approval.amountCents)} mailed ${when.toISOString().slice(0, 10)}.`, by);
    return true;
  });
  await notify().referrerMailed(doc);
  return doc;
}

async function voidReward(id, { reason, by }) {
  if (clean(reason, 300).length < 3) throw new ReferralError("REASON_REQUIRED", "Give a reason.");
  return mutate(id, async (d) => {
    if (d.status === "mailed") throw new ReferralError("MAILED", "The check was already mailed. Record what happened in a note instead.", 409);
    if (d.status === "void") return false;
    d.status = "void";
    d.reason = clean(reason, 300);
    d.attention = "";
    historyPush(d, "void", `Voided by the owner: ${clean(reason, 300)}`, by);
    return true;
  });
}

async function acknowledge(id, { note, by }) {
  return mutate(id, async (d) => {
    if (!d.attention) return false;
    historyPush(d, "attention_closed", `${d.attention} Owner: ${clean(note, 300) || "seen"}.`, by);
    d.attention = "";
    return true;
  });
}

module.exports = {
  ReferralError,
  bindReferral,
  bindFromRequest,
  referralFromBody,
  hadPaidMembership,
  onInvoicePaid,
  onChargeRefunded,
  onDispute,
  recheck,
  setPayee,
  readPayee,
  clearFlags,
  approve,
  markMailed,
  voidReward,
  acknowledge,
};
