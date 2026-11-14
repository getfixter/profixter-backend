/**
 * Self-referral check: does a sale credited to (or claimed by) an employee look
 * like the employee buying for themselves, or for someone they live with?
 *
 * It only ever FLAGS. A flagged automatic credit is held for the owner (hold
 * reason "self_referral_check"); a flagged credit request needs the owner to
 * confirm the check when approving. Nothing is refused or deducted, because a
 * household member, a neighbour in the same building or a relative sharing a
 * card can be a perfectly genuine customer: the owner decides, with a reason.
 *
 * Signals (each with a strength the owner sees):
 *   same_person  the customer account IS the employee's account; same email
 *                (ignoring case, "+tags" and Gmail dots); same phone
 *   payment      the card that paid (Stripe's card fingerprint, a hash, never
 *                shown) also paid for a sale of a DIFFERENT customer credited
 *                to or claimed by this employee
 *   household    a customer address is the employee's home address (recorded
 *                by the owner on the employee; optional)
 *
 * A shared surname alone is NOT a signal: too common to be useful, and it
 * would flag legitimate customers for no reason.
 */
const User = require("../../models/User");
const { SalesCredit, SalesCreditRequest, SalesEvent } = require("../../models/Sales");

function normEmail(v) {
  const s = String(v || "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at < 1) return "";
  let local = s.slice(0, at).split("+")[0];
  let domain = s.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.replace(/\./g, "");
  return local ? `${local}@${domain}` : "";
}

function normPhone(v) {
  const d = String(v || "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : "";
}

const ABBR = { street: "st", avenue: "ave", av: "ave", road: "rd", drive: "dr", lane: "ln", court: "ct", place: "pl", boulevard: "blvd", terrace: "ter", circle: "cir", highway: "hwy", parkway: "pkwy", turnpike: "tpke", north: "n", south: "s", east: "e", west: "w", apartment: "apt", suite: "ste", unit: "apt", "#": "apt" };
function words(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/#/g, " # ")
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => ABBR[w] || w);
}
/**
 * Street line and unit, normalised. Customer addresses keep the apartment in
 * `unit` or folded into line1 ("12 Main Street, Apt. 3"); both read the same:
 * { street: "12 main st", unit: "3" }.
 */
function normAddress(a) {
  if (!a) return null;
  const all = words(a.line1);
  const i = all.findIndex((w) => w === "apt" || w === "ste" || w === "fl");
  const street = (i >= 0 ? all.slice(0, i) : all).join(" ");
  const explicit = words(a.unit).filter((w) => !["apt", "ste", "fl"].includes(w)).join(" ");
  const unit = explicit || (i >= 0 ? all.slice(i + 1).join(" ") : "");
  const zip = String(a.zip || a.postalCode || "").replace(/\D/g, "").slice(0, 5);
  if (!street || !/\d/.test(street)) return null;
  return { street, unit, zip };
}
/** Same street line, same ZIP (when both have one) and no conflicting unit numbers. */
function sameAddress(a, b) {
  const x = normAddress(a);
  const y = normAddress(b);
  if (!x || !y || x.street !== y.street) return false;
  if (x.zip && y.zip && x.zip !== y.zip) return false;
  if (!x.zip && !y.zip) return false;
  if (x.unit && y.unit && x.unit !== y.unit) return false;
  return true;
}

const TEXT = {
  own_account: "The customer account is the employee's own account.",
  same_email: "The customer's email is the employee's own email.",
  same_phone: "The customer's phone number is the employee's own number.",
  same_card: (n) => `The card that paid also paid for ${n} other customer${n === 1 ? "'s" : "s'"} purchase${n === 1 ? "" : "s"} credited to or claimed by this employee.`,
  same_home_address: (unitNote) => `A customer address matches the employee's home address${unitNote}. This can be a household member or a neighbour; a genuine household purchase can still be credited.`,
};

/**
 * The signals for one employee and one sale (or, without a sale, one
 * customer account). Never throws: a failure means no signals, logged.
 */
async function signalsFor({ employeeId, userId, sale = null, lead = null }) {
  try {
    if (!employeeId) return [];
    const employee = await User.findById(employeeId).select("email phone staffHomeAddress").lean();
    if (!employee) return [];
    const out = [];
    const customerId = userId || sale?.user || null;
    const customer = customerId ? await User.findById(customerId).select("email phone addresses").lean() : null;
    if (customerId && String(customerId) === String(employeeId)) out.push({ code: "own_account", strength: "same_person", text: TEXT.own_account });

    const empEmail = normEmail(employee.email);
    const emails = [customer?.email, lead?.email].map(normEmail).filter(Boolean);
    if (empEmail && emails.includes(empEmail)) out.push({ code: "same_email", strength: "same_person", text: TEXT.same_email });

    const empPhone = normPhone(employee.phone);
    const phones = [customer?.phone, lead?.phone].map(normPhone).filter(Boolean);
    if (empPhone && phones.includes(empPhone)) out.push({ code: "same_phone", strength: "same_person", text: TEXT.same_phone });

    const home = employee.staffHomeAddress;
    if (home && home.line1) {
      const match = (customer?.addresses || []).find((a) => sameAddress(a, home));
      if (match) {
        const unitNote = normAddress(match)?.unit || normAddress(home)?.unit ? "" : " (no apartment number on one or both, so it may be the same building)";
        out.push({ code: "same_home_address", strength: "household", text: TEXT.same_home_address(unitNote) });
      }
    }

    const fp = sale?.stripe?.cardFingerprint;
    if (fp) {
      const others = await SalesEvent.find({ "stripe.cardFingerprint": fp, _id: { $ne: sale._id }, user: { $ne: sale.user }, kind: { $in: ["membership_first_paid", "membership_change_paid", "full_day_paid"] } }).select("_id").lean();
      if (others.length) {
        const ids = others.map((o) => o._id);
        const credited = await SalesCredit.find({ sale: { $in: ids }, $or: [{ employee: employeeId }, { "claimants.employee": employeeId }] }).select("sale").lean();
        const requested = await SalesCreditRequest.find({ sale: { $in: ids }, employee: employeeId }).select("sale").lean();
        const n = new Set([...credited, ...requested].map((x) => String(x.sale))).size;
        if (n) out.push({ code: "same_card", strength: "payment", text: TEXT.same_card(n) });
      }
    }
    return out;
  } catch (error) {
    console.error(JSON.stringify({ area: "sales", event: "self_referral_check_failed", message: String(error?.message || error).slice(0, 200) }));
    return [];
  }
}

/** A one-line summary for the owner's review card. */
function summaryOf(signals) {
  if (!signals.length) return "";
  const kinds = new Set(signals.map((s) => s.strength));
  const head = kinds.has("same_person") ? "may be the employee's own purchase" : kinds.has("payment") ? "paid with a card used for another of this employee's customers" : "same home address as the employee (possibly a household member)";
  return `Self-referral check: ${head}. Check before crediting; a genuine customer can still be credited.`;
}

module.exports = { signalsFor, summaryOf, normEmail, normPhone, normAddress, sameAddress };
