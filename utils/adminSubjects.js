/**
 * Subject lines for Admin notifications.
 *
 * The Admin inbox is a notification centre, and most of these are read as a
 * phone banner and never opened. So the subject has to carry the whole message:
 * what happened, to whom, and whether it needs a response. That last part is
 * the reason this file exists in one place rather than as a string at each call
 * site, because "does this need me" is a judgment about the whole set, and it
 * drifts the moment two people make it independently.
 *
 * Three tiers, distinguished by wording rather than by a "[HIGH]" tag:
 *
 *   informational  Title Case. Something happened; awareness is enough.
 *                  Registrations and ordinary booking activity.
 *
 *   medium         Title Case, and it leads with the thing that changed: the
 *                  plan, or the money. Revenue and customer status.
 *
 *   high           UPPERCASE lead phrase. Somebody is waiting for a reply.
 *                  Only real leads and explicit contact requests earn this,
 *                  because a shout that happens forty times a week is not a
 *                  shout any more.
 *
 * Registration is deliberately not a lead. Creating an account is not asking to
 * be contacted, and calling it a lead trains the reader to ignore the word by
 * the time somebody actually asks for a call.
 */

const IMPORTANCE = {
  INFORMATIONAL: "informational",
  MEDIUM: "medium",
  HIGH: "high",
};

const TIMEZONE = "America/New_York";

function personName(name) {
  const value = String(name || "").trim();
  return value || "Customer";
}

/** "Aug 18, 10:00 AM" or, when only the day matters, "Aug 18". */
function whenLabel(date, { withTime = true } = {}) {
  if (!date) return "";
  const value = new Date(date);
  if (Number.isNaN(value.getTime())) return "";
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    month: "short",
    day: "numeric",
  }).format(value);
  if (!withTime) return day;
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
  return `${day}, ${time}`;
}

function planLabel(plan) {
  const value = String(plan || "").trim();
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "";
}

/** Join the parts that exist, so a missing plan never leaves a dangling dash. */
function subject(parts) {
  return parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" - ");
}

/* ------------------------------------------------------------------ */
/* Informational: awareness only                                       */
/* ------------------------------------------------------------------ */

/** Someone made an account. Not a lead. */
function registration(name) {
  return subject(["New Registration", personName(name)]);
}

/**
 * Ordinary booking activity. The date is in the subject precisely so the email
 * usually does not need opening.
 */
function booking(event, { name, date, withTime = true } = {}) {
  return subject([event, personName(name), whenLabel(date, { withTime })]);
}

/* ------------------------------------------------------------------ */
/* Medium: revenue and customer status                                 */
/* ------------------------------------------------------------------ */

function membership(event, { name, plan } = {}) {
  return subject([event, personName(name), planLabel(plan)]);
}

/**
 * Money that has arrived. The amount leads the customer, because the amount is
 * what decides whether this is worth a look.
 */
function payment(event, { amount, name } = {}) {
  return subject([event, amount, personName(name)]);
}

/* ------------------------------------------------------------------ */
/* High: somebody is waiting for a reply                               */
/* ------------------------------------------------------------------ */

function lead(kind, name) {
  return subject([String(kind || "NEW LEAD").toUpperCase(), personName(name)]);
}

/**
 * Which kind of real lead this is, from whatever the form recorded.
 *
 * Registrations are filtered out before this is reached; anything landing here
 * is somebody who asked to be contacted.
 */
function leadKindFor({ leadType = "", service = "", sourcePage = "" } = {}) {
  const haystack = `${leadType} ${service} ${sourcePage}`.toLowerCase();
  if (haystack.includes("community") || haystack.includes("partnership")) {
    return "COMMUNITY REQUEST";
  }
  // Membership is checked before the generic call/callback wording, because a
  // membership enquiry is usually phrased as a call request and the plan is the
  // more useful half of the sentence.
  if (haystack.includes("membership") || haystack.includes("subscription")) {
    return "NEW MEMBERSHIP LEAD";
  }
  if (haystack.includes("callback") || haystack.includes("call request")) {
    return "CALL REQUEST";
  }
  if (haystack.includes("one-time") || haystack.includes("one time") || haystack.includes("on-demand")) {
    return "CALL REQUEST";
  }
  if (haystack.includes("feedback")) return "CUSTOMER FEEDBACK";
  return "NEW PROJECT LEAD";
}

/** Registrations must never be treated as leads. */
function isRegistration({ leadType = "", service = "" } = {}) {
  const haystack = `${leadType} ${service}`.toLowerCase();
  return haystack.includes("registration") || haystack.includes("account registration");
}

module.exports = {
  IMPORTANCE,
  booking,
  isRegistration,
  lead,
  leadKindFor,
  membership,
  payment,
  planLabel,
  registration,
  subject,
  whenLabel,
};
