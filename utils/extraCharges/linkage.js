/**
 * Who pays for an extra on this booking: resolved on the server, from the
 * booking's stored account and nothing else.
 *
 *   booking.user (the stored account id)  ->  that User  ->  its stripeCustomerId
 *   ->  that Stripe customer  ->  ITS default card, retrieved and checked to be
 *   attached to that exact customer.
 *
 * Never by name, email, phone, address or whichever profile Admin has open,
 * and never from an id the browser sends. Anything missing, conflicting or
 * ambiguous blocks direct charging with a specific reason; the booking-specific
 * payment link (Stripe-hosted, the customer pays themselves) stays available
 * where it is safe.
 *
 * This deliberately does NOT use subscriptionManagement.resolveUserStripeCustomerId,
 * which falls back to the first Stripe customer with the same email.
 */
const mongoose = require("mongoose");
const User = require("../../models/User");
const Subscription = require("../../models/Subscription");

const ADMIN_EMAIL = () => String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();

const MESSAGES = {
  GUEST_BOOKING: "This is a guest visit with no account, so there is no saved card to charge. Use a payment link.",
  ACCOUNT_MISSING: "The account this visit belongs to no longer exists. Use a payment link to the booking's contact.",
  OWNERSHIP_CONFLICT: "This visit's account records disagree, so it is not safe to charge a saved card. Use a payment link, or fix the visit's account first.",
  STAFF_ACCOUNT: "This visit is on a staff account. Staff accounts are never charged here.",
  NO_STRIPE_CUSTOMER: "This account has no Stripe customer, so there is no saved card. Use a payment link.",
  STRIPE_CUSTOMER_SHARED: "This account's Stripe customer is also linked to another account, so the card could be someone else's. Use a payment link, and fix the duplicate in Admin.",
  MULTIPLE_STRIPE_CUSTOMERS: "This account is linked to more than one Stripe customer, so the right card is not certain. Use a payment link.",
  STRIPE_CUSTOMER_DELETED: "This account's Stripe customer was deleted in Stripe. Use a payment link.",
  STRIPE_CUSTOMER_MISMATCH: "The Stripe customer on this account is labelled for a different account in Stripe. It is not safe to charge. Use a payment link.",
  NO_SAVED_CARD: "There is no saved card on this customer. Use a payment link.",
  NO_DEFAULT_CARD: "This customer has several saved cards and none is the default, so the right one is not certain. Use a payment link.",
  PM_NOT_OWNED: "The saved card is not attached to this customer in Stripe. It was not charged. Use a payment link.",
  NOT_A_CARD: "The saved payment method is not a card. Use a payment link.",
  CARD_EXPIRED: "The saved card has expired. Use a payment link.",
  STRIPE_UNAVAILABLE: "Stripe could not be reached to check the saved card. Nothing was charged. Try again in a moment.",
  NO_CONTACT: "There is no email or mobile number for this visit to send a link to. Copy the link instead.",
};

const blocker = (code, extra = {}) => ({ code, message: MESSAGES[code] || code, ...extra });
const idOf = (v) => (v && typeof v === "object" ? String(v.id || "") : String(v || ""));

function isGuestBooking(booking) {
  return Boolean(booking.guestRequestId || booking.adminGuest || !booking.user);
}

function isStaff(user) {
  return String(user?.email || "").toLowerCase() === ADMIN_EMAIL() || user?.role === "admin" || user?.role === "employee" || Boolean(user?.employeePosition);
}

/** The service address the work was done at (for tax and for the owner to read back). */
function serviceAddressFor(booking, user) {
  let fromAccount = null;
  if (user && booking.addressId && Array.isArray(user.addresses)) {
    fromAccount = user.addresses.find((a) => String(a._id) === String(booking.addressId)) || null;
  }
  const pick = (k, bk = k) => String((fromAccount && fromAccount[k]) || booking[bk] || "").trim();
  return {
    line1: String((fromAccount && fromAccount.line1) || booking.address || "").trim(),
    unit: pick("unit"),
    city: pick("city"),
    state: pick("state").toUpperCase(),
    zip: pick("zip").slice(0, 10),
  };
}

function fullAddressText(a) {
  return [a.line1, a.unit, a.city, [a.state, a.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
}

function cardOf(pm) {
  const c = pm?.card || {};
  return { brand: String(c.brand || ""), last4: String(c.last4 || ""), expMonth: Number(c.exp_month) || null, expYear: Number(c.exp_year) || null };
}

function cardExpired(card, now = new Date()) {
  if (!card.expYear || !card.expMonth) return false;
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth() + 1;
  return card.expYear < y || (card.expYear === y && card.expMonth < m);
}

/**
 * Pick the card Stripe would bill: the customer's default, else the one
 * default shared by their active subscriptions, else their only card.
 * Returns { paymentMethod } or { blocker }.
 */
async function pickPaymentMethod(stripe, customer) {
  const customerId = customer.id;
  let pmId = idOf(customer.invoice_settings?.default_payment_method);
  if (!pmId) {
    const subs = await stripe.subscriptions.list({ customer: customerId, status: "active", limit: 10 });
    const defaults = [...new Set((subs?.data || []).map((s) => idOf(s.default_payment_method)).filter(Boolean))];
    if (defaults.length === 1) pmId = defaults[0];
  }
  if (!pmId) {
    const list = await stripe.paymentMethods.list({ customer: customerId, type: "card", limit: 10 });
    const cards = list?.data || [];
    if (cards.length === 0) return { blocker: blocker("NO_SAVED_CARD") };
    if (cards.length > 1) return { blocker: blocker("NO_DEFAULT_CARD") };
    pmId = cards[0].id;
  }
  // Retrieved on its own, so the attachment is Stripe's answer, not the list's.
  const pm = await stripe.paymentMethods.retrieve(pmId);
  if (!pm || idOf(pm.customer) !== customerId) return { blocker: blocker("PM_NOT_OWNED") };
  if (pm.type !== "card") return { blocker: blocker("NOT_A_CARD") };
  const card = cardOf(pm);
  if (cardExpired(card)) return { blocker: blocker("CARD_EXPIRED", { card }) };
  return { paymentMethod: { id: pm.id, card } };
}

/**
 * @returns {Promise<{
 *   guest: boolean, user: object|null, accountUserId: string,
 *   customerId: string, customerLinked: boolean,
 *   customerName: string, contact: {name,email,phone}, serviceAddress: object,
 *   paymentMethodId: string, card: object|null,
 *   direct: {allowed: boolean, code?: string, message?: string},
 *   link: {allowed: boolean, code?: string, message?: string, canSend: boolean}
 * }>}
 */
async function resolveChargeTarget(booking, { stripe }) {
  const out = {
    guest: isGuestBooking(booking),
    user: null,
    accountUserId: "",
    customerId: "",
    customerLinked: false,
    customerName: String(booking.name || "").trim(),
    contact: { name: String(booking.name || ""), email: String(booking.email || ""), phone: String(booking.phone || "") },
    serviceAddress: serviceAddressFor(booking, null),
    paymentMethodId: "",
    card: null,
    direct: { allowed: false },
    link: { allowed: true, canSend: false },
  };
  const finish = (directBlocker, linkBlocker = null) => {
    out.direct = directBlocker ? { allowed: false, ...directBlocker } : { allowed: true };
    if (linkBlocker) out.link = { allowed: false, canSend: false, ...linkBlocker };
    else out.link = { allowed: true, canSend: Boolean(out.contact.email || out.contact.phone) };
    return out;
  };

  if (out.guest) return finish(blocker("GUEST_BOOKING"));

  if (!mongoose.isValidObjectId(booking.user)) return finish(blocker("ACCOUNT_MISSING"));
  const user = await User.findById(booking.user);
  if (!user) return finish(blocker("ACCOUNT_MISSING"));
  if (isStaff(user)) return finish(blocker("STAFF_ACCOUNT"), blocker("STAFF_ACCOUNT"));

  // The booking stores the account twice (ObjectId and the public id): they must agree.
  const publicIds = [String(user.userId || ""), String(user._id)].filter(Boolean);
  if (booking.userId && !publicIds.includes(String(booking.userId))) return finish(blocker("OWNERSHIP_CONFLICT"));

  out.user = user;
  out.accountUserId = String(user._id);
  out.customerName = String(user.name || booking.name || "").trim();
  out.contact = { name: out.customerName, email: String(user.email || ""), phone: String(user.phone || "") };
  out.serviceAddress = serviceAddressFor(booking, user);

  const customerId = String(user.stripeCustomerId || "").trim();
  if (!customerId.startsWith("cus_")) return finish(blocker("NO_STRIPE_CUSTOMER"));

  // The mapping must be one-to-one in our own records.
  const [otherUsers, subCustomers, foreignSubs] = await Promise.all([
    User.countDocuments({ _id: { $ne: user._id }, stripeCustomerId: customerId }),
    Subscription.distinct("stripeCustomerId", { user: user._id, stripeCustomerId: { $nin: [null, ""] } }),
    Subscription.countDocuments({ stripeCustomerId: customerId, user: { $ne: user._id } }),
  ]);
  if (otherUsers > 0 || foreignSubs > 0) return finish(blocker("STRIPE_CUSTOMER_SHARED"));
  if (subCustomers.some((id) => String(id) !== customerId)) return finish(blocker("MULTIPLE_STRIPE_CUSTOMERS"));

  let customer;
  try {
    customer = await stripe.customers.retrieve(customerId);
  } catch (error) {
    if (error?.statusCode === 404 || error?.code === "resource_missing") return finish(blocker("STRIPE_CUSTOMER_DELETED"));
    return finish(blocker("STRIPE_UNAVAILABLE"));
  }
  if (!customer || customer.deleted) return finish(blocker("STRIPE_CUSTOMER_DELETED"));
  const stamped = [customer.metadata?.userMongoId, customer.metadata?.mongoUserId, customer.metadata?.userId].map((v) => String(v || "").trim()).filter(Boolean);
  if (stamped.length && !stamped.some((v) => publicIds.includes(v))) return finish(blocker("STRIPE_CUSTOMER_MISMATCH"));

  out.customerId = customerId;
  out.customerLinked = true;

  try {
    const picked = await pickPaymentMethod(stripe, customer);
    if (picked.blocker) {
      if (picked.blocker.card) out.card = picked.blocker.card;
      return finish(picked.blocker);
    }
    out.paymentMethodId = picked.paymentMethod.id;
    out.card = picked.paymentMethod.card;
  } catch (error) {
    return finish(blocker("STRIPE_UNAVAILABLE"));
  }
  return finish(null);
}

module.exports = { MESSAGES, cardExpired, fullAddressText, isGuestBooking, resolveChargeTarget, serviceAddressFor };
