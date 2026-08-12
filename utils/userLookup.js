/**
 * Resolving a person by email, now that an email can mean two people.
 *
 * THE PROBLEM THIS EXISTS FOR
 * One human may hold a customer account and a separate Fixter account on the
 * same email. Every `User.findOne({ email })` in the codebase was written when
 * that was impossible, and each one now has to say which account it means.
 * Leaving them to guess is how the wrong person gets billed, or logged in.
 *
 * THE RULE
 * Billing, membership and anything a customer does resolves the CUSTOMER
 * record. Employee tooling resolves the EMPLOYEE record. Nothing resolves
 * "whichever came back first".
 *
 * WHY PREFERENCE RATHER THAN A STRICT FILTER
 * A strict `role: "customer"` filter would break the 115 legacy accounts whose
 * role is null, and they are customers in everything but the field. So these
 * order the candidates and take the best one: for every account that exists
 * today, with exactly one record per email, the answer is identical to what
 * the old unqualified lookup returned. The ordering only starts to matter once
 * somebody genuinely holds both.
 */

const User = require("../models/User");

function cleanEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isEmployeeRecord(user) {
  return String(user?.role || "") === "employee";
}

/** Every account on this address. At most two in practice: one of each kind. */
async function findUsersByEmail(email, { lean = false } = {}) {
  const address = cleanEmail(email);
  if (!address) return [];
  const query = User.find({ email: address });
  return lean ? query.lean() : query;
}

/**
 * The customer behind an email.
 *
 * Used by everything that is about money the customer pays us, or about their
 * membership: Stripe, invoices, subscriptions, sign-in for the customer app.
 * An employee record must never answer these, because it has no subscription,
 * no addresses and no billing history, and picking it would silently detach a
 * real customer from their own payments.
 */
async function findCustomerByEmail(email, options) {
  const users = await findUsersByEmail(email, options);
  if (!users.length) return null;
  return users.find((user) => !isEmployeeRecord(user)) || null;
}

/** The employee behind an email, for staff tooling and employee sign-in. */
async function findEmployeeByEmail(email, options) {
  const users = await findUsersByEmail(email, options);
  return users.find(isEmployeeRecord) || null;
}

/**
 * The customer if there is one, otherwise whatever single account exists.
 *
 * The compatibility shim for call sites that predate this and are about
 * customers in spirit. It cannot return an employee record while a customer
 * record exists, which is the property that matters; the fallback only fires
 * for an email that has nothing but an employee account, where returning null
 * would be a behaviour change rather than a safety improvement.
 */
async function findBillingUserByEmail(email, options) {
  const users = await findUsersByEmail(email, options);
  if (!users.length) return null;
  return users.find((user) => !isEmployeeRecord(user)) || users[0];
}

/** Whether this address already has an account of this kind. */
async function emailTakenBy(email, { employee = false } = {}) {
  const address = cleanEmail(email);
  if (!address) return false;
  const query = employee
    ? { email: address, role: "employee" }
    : { email: address };
  return !!(await User.exists(query));
}

module.exports = {
  cleanEmail,
  emailTakenBy,
  findBillingUserByEmail,
  findCustomerByEmail,
  findEmployeeByEmail,
  findUsersByEmail,
  isEmployeeRecord,
};
