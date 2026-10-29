/**
 * What a customer still has to give us before a visit can be booked.
 *
 * A Booking needs a name (who the Fixter asks for), a phone (the Fixter calls
 * from the driveway) and an email (the confirmation and receipt). Accounts made by phone or email code start
 * with one of the two, so the booking step asks for the other at the moment it
 * is needed - instead of sign-up asking everyone for everything up front.
 */
function missingBookingContact(user) {
  const missing = [];
  // The Fixter needs to know who to ask for at the door.
  if (!String(user?.name || "").trim()) missing.push("name");
  if (!String(user?.phone || "").trim()) missing.push("phone");
  if (!String(user?.email || "").trim()) missing.push("email");
  return missing;
}

/** The 400 every booking and paid checkout returns, so the app shows one inline step. */
function contactRequiredBody(missing) {
  const label = { name: "name", phone: "mobile number", email: "email address" };
  const words = missing.map((field) => label[field] || field).join(" and ");
  return { code: "CONTACT_REQUIRED", missing, message: `Add your ${words} to continue.` };
}

module.exports = { contactRequiredBody, missingBookingContact };
