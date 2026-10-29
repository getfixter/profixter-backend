const mongoose = require("mongoose");
const User = require("../../models/User");
const { effectiveRole } = require("../../middleware/authorize");
const { normalizeEmail } = require("../identity");

/**
 * The owner buying a gift for a registered customer, from Admin.
 *
 * NOT A SECOND GIFTING SYSTEM. This only decides WHO the gift is for; the
 * purchase itself goes through the ordinary /gifts/checkout-session route, so
 * the price, the tax, promotion codes, the one-time Stripe payment on the
 * owner's own card, the webhook that records the gift only once payment is
 * confirmed, the invitation and the claim rules are exactly what every
 * customer gets.
 *
 * THE RECIPIENT EMAIL COMES FROM THE CUSTOMER'S ACCOUNT, NEVER THE BROWSER.
 * A gift is claimed by signing in with the email it was sent to, so the email
 * is the gift's identity. Reading it from the database by the customer's id
 * is what guarantees the gift can only ever be claimed by the customer the
 * owner picked: a stale form, a mistyped address or an edited request cannot
 * point it at somebody else.
 *
 * Name, phone and address are pre-filled from the profile and may be
 * completed by the owner, because those are presentation and delivery
 * details. None of them decides who can claim the gift.
 */

function splitName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function trimmed(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

/**
 * Who the gift is for, resolved from the customer's record.
 *
 * Returns { ok: true, recipient, address, customerId } shaped exactly like the
 * checkout body's own recipient and address, or { ok: false, status, code,
 * message } for the route to send back unchanged.
 */
async function resolveAdminGiftTarget({ purchaser, forCustomer, recipient = {}, address = {}, UserModel = User }) {
  if (effectiveRole(purchaser) !== "admin") {
    return { ok: false, status: 403, code: "ADMIN_ONLY", message: "Only the owner can buy a gift for a customer." };
  }

  const customerId = String(forCustomer?.userId || "");
  if (!mongoose.isValidObjectId(customerId)) {
    return { ok: false, status: 400, code: "INVALID_CUSTOMER", message: "Choose a customer for this gift." };
  }

  const customer = await UserModel.findById(customerId)
    .select("_id userId name firstName lastName email phone role addresses")
    .lean();
  if (!customer || customer.role === "employee") {
    return { ok: false, status: 404, code: "CUSTOMER_NOT_FOUND", message: "That customer could not be found." };
  }
  if (String(customer._id) === String(purchaser._id)) {
    return { ok: false, status: 400, code: "SELF_GIFT_NOT_ALLOWED", message: "A gift has to be for a customer." };
  }

  const email = normalizeEmail(customer.email);
  if (!email) {
    return {
      ok: false,
      status: 400,
      code: "CUSTOMER_HAS_NO_EMAIL",
      message: "This customer has no email on their account, so they could not claim a gift.",
    };
  }

  /*
   * The owner's edits win for name and phone; the profile fills anything left
   * blank. An explicitly empty phone means "do not send to a phone", which is
   * a delivery choice the owner is allowed to make.
   */
  const fromProfile = customer.firstName || customer.lastName
    ? { firstName: customer.firstName || "", lastName: customer.lastName || "" }
    : splitName(customer.name);
  const firstName = trimmed(recipient.firstName, 80) || fromProfile.firstName;
  const lastName = trimmed(recipient.lastName, 80) || fromProfile.lastName;
  const phone = Object.prototype.hasOwnProperty.call(recipient, "phone")
    ? trimmed(recipient.phone, 40)
    : trimmed(customer.phone, 40);

  /*
   * A property the customer already has is read from their record, so the
   * address on the gift is exactly the one on file. Only a customer with no
   * address on file uses what the owner typed.
   */
  const addressId = String(forCustomer?.addressId || "");
  let giftAddress;
  if (addressId) {
    const onFile = (customer.addresses || []).find((entry) => String(entry._id) === addressId);
    if (!onFile) {
      return { ok: false, status: 400, code: "ADDRESS_NOT_ON_ACCOUNT", message: "That address is not on this customer's account." };
    }
    giftAddress = { line1: onFile.line1 || "", city: onFile.city || "", state: onFile.state || "", zip: onFile.zip || "" };
  } else {
    giftAddress = {
      line1: trimmed(address.line1, 200),
      city: trimmed(address.city, 100),
      state: trimmed(address.state, 40),
      zip: trimmed(address.zip, 20),
    };
  }

  return {
    ok: true,
    customerId: String(customer._id),
    recipient: { email, phone, firstName, lastName },
    address: giftAddress,
  };
}

module.exports = { resolveAdminGiftTarget, splitName };
