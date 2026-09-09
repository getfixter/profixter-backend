const { LINKS, MAX_BODY_LENGTH, TIMEZONE, reviewLinkEnabled } = require("./smsConfig");

/**
 * Every word ProFixter sends by SMS.
 *
 * NO MESSAGE STRING LIVES ANYWHERE ELSE. A trigger passes facts and gets back a
 * rendered body; it never assembles copy. That is what makes it possible to
 * read every text the company can send in one sitting, and to change the tone
 * of all of them without touching a route handler.
 *
 * WHY THE VISIT VOCABULARY IS CENTRAL HERE
 * ProFixter sells four different things that all look like "an appointment" in
 * the database, and telling a customer the wrong one is the most likely and
 * most damaging mistake this system could make. Somebody who paid $499 for a
 * Full Day must not be told about a 90-minute visit; somebody on a free first
 * visit must not be told it is included in a membership they do not have. The
 * classification lives in one function, visitVocabulary, and every template
 * reads from it rather than guessing.
 */

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A real instant, or null.
 *
 * The emptiness check is not redundant, and leaving it out is a genuine bug
 * rather than a tidiness question: `new Date(null)` is the epoch, not an
 * invalid date, so a booking with a null date would render as "Wed, Dec 31 at
 * 7:00 PM" and go out to a customer looking entirely plausible. Same trap, and
 * the same guard, as bookingStartMs in utils/bookingReminderPolicy.
 */
function toInstant(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/**
 * Dates are always formatted in New York, from an absolute instant.
 *
 * Intl does the DST arithmetic, which is the whole reason not to compute an
 * offset by hand: an appointment at 2pm on the Sunday the clocks move is 2pm to
 * the customer, and any code that subtracts a fixed number of hours from UTC
 * gets that wrong twice a year in opposite directions.
 */
function formatDateTime(value) {
  const date = toInstant(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  })
    .format(date)
    .replace(/,\s+(\d)/, " at $1");
}

/** Day only. A Full Day has no meaningful start time to quote. */
function formatDateOnly(value) {
  const date = toInstant(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

/** Time only, for the hour-before reminder where the day is not in doubt. */
function formatTimeOnly(value) {
  const date = toInstant(value);
  if (!date) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

/**
 * A value from the database, made safe to drop into a text message.
 *
 * There is no markup in SMS, so this is not escaping in the HTML sense. It
 * guards three real problems instead:
 *
 *   - Newlines and control characters, which turn one message into something
 *     that renders as several and wrecks the segment estimate.
 *   - Anything that looks like a link. Names, service descriptions and notes
 *     are customer-supplied, and a message from ProFixter carrying a URL a
 *     customer typed is a phishing vector we would be paying to deliver.
 *   - Unbounded length, because a 400-character "service name" would push the
 *     tip link off the end of the message that exists to carry it.
 */
function clean(value, maxLength = 60) {
  const text = String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const delinked = text
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\b[\w.-]+\.(com|net|org|io|co|us|info|biz)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return delinked.slice(0, maxLength).trim();
}

/** A first name to greet with, or a neutral fallback. Never an empty greeting. */
function firstNameOf(name, fallback = "there") {
  const cleaned = clean(name, 40);
  if (!cleaned) return fallback;
  const first = cleaned.split(" ")[0];
  return first || fallback;
}

/* -------------------------------------------------------------------------- */
/* Visit vocabulary                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What to call this appointment, and what is true about it.
 *
 * ORDER OF THE CHECKS IS THE WHOLE CORRECTNESS ARGUMENT.
 *
 * Full Day is tested first because a purchased Full Day carries
 * accessType "one_time" and would otherwise answer to the One-Time Visit
 * branch — which would tell a customer who bought a whole workday for $499
 * that they had booked a 90-minute visit. The same trap exists in the email
 * templates and is handled the same way there.
 *
 * Free first visit is tested next, because it carries bookingType
 * "membership_visit" and would otherwise be described as a membership visit to
 * somebody who has no membership.
 */
function visitVocabulary(booking = {}) {
  const bookingType = String(booking.bookingType || "");
  const accessType = String(booking.accessType || "");
  const service = String(booking.service || "");

  const isFullDay = bookingType === "full_day_visit" || /full\s*day/i.test(service);
  if (isFullDay) {
    return {
      kind: "full_day",
      /*
       * "Full Day Service" is the CUSTOMER-FACING name, and it lives only
       * here. The database type stays full_day_visit, the internal kind stays
       * full_day, and the service-string match above is untouched — renaming
       * any of those would be a data migration wearing a copy change's
       * clothes. What a customer reads and what a record is called are two
       * different things, and this is the only place the first one is decided.
       */
      noun: "Full Day Service",
      shortNoun: "Full Day Service",
      /* No start time is quoted: a Full Day is the workday, not a slot. */
      wholeDay: true,
      completionNote: "We hope the day made a real dent in your list.",
    };
  }

  const isFreeFirst =
    accessType === "free_first_visit" || booking.isFreeFirstVisit === true;
  if (isFreeFirst) {
    return {
      kind: "free_first",
      noun: "free first visit",
      shortNoun: "free first visit",
      wholeDay: false,
      completionNote: "We hope you liked how we work.",
    };
  }

  const isOneTime =
    bookingType === "one_time_handyman_visit" ||
    accessType === "one_time" ||
    /one[\s-]?time/i.test(service);
  if (isOneTime) {
    return {
      kind: "one_time",
      noun: "One-Time Visit",
      shortNoun: "One-Time Visit",
      wholeDay: false,
      completionNote: "Thanks for giving us a try.",
    };
  }

  return {
    kind: "membership",
    noun: "membership visit",
    shortNoun: "visit",
    wholeDay: false,
    completionNote: "Your next visit is always included.",
  };
}

/** When to say the appointment is, phrased for its kind. */
function whenPhrase(booking = {}) {
  const vocab = visitVocabulary(booking);
  return vocab.wholeDay ? formatDateOnly(booking.date) : formatDateTime(booking.date);
}

/**
 * How far either side of the booked time a Fixter may arrive.
 *
 * The real policy is booked time plus or minus thirty minutes. It is stated
 * once, here, so the number in the message and the number in the tests cannot
 * drift apart.
 */
const ARRIVAL_WINDOW_MS = 30 * 60 * 1000;

/**
 * The arrival window a customer should expect, as a readable range.
 *
 * PURELY DISPLAY. Nothing here touches booking.date, the schedule, the
 * reservation or the reminder timing — it derives two labels from an instant
 * and returns a string. The appointment is still the appointment.
 *
 * Both ends are formatted through Intl in New York, from absolute instants, so
 * three things fall out for free rather than needing special cases:
 *
 *   - Midnight and noon come out as 12:00 AM and 12:00 PM, not 0:00 or 24:00.
 *   - A window that crosses midnight (a 12:15 AM slot opens at 11:45 PM the
 *     day before) still reads correctly, because subtracting from an instant
 *     rolls the date properly and the formatter is told nothing about days.
 *   - A window that straddles a DST change is computed on instants, so the
 *     clock labels are whatever New York actually showed at those moments.
 *
 * The separator is an ASCII hyphen, deliberately, and it matters more than it
 * looks: an en dash is outside GSM-7, and one of them anywhere in a message
 * forces the whole thing to UCS-2, cutting a single segment from 160
 * characters to 70. That would push this reminder to two segments and double
 * what every reminder costs to send.
 */
function arrivalWindow(value) {
  const date = toInstant(value);
  if (!date) return "";
  const start = formatTimeOnly(new Date(date.getTime() - ARRIVAL_WINDOW_MS));
  const end = formatTimeOnly(new Date(date.getTime() + ARRIVAL_WINDOW_MS));
  if (!start || !end) return "";
  return `${start} - ${end}`;
}

/* -------------------------------------------------------------------------- */
/* Shared fragments                                                            */
/* -------------------------------------------------------------------------- */

const BRAND = "ProFixter";
const SUPPORT_PHONE = "631-599-1363";
const SITE = "profixter.com";

/**
 * The opt-out sentence.
 *
 * Required on marketing, and enforced by a test rather than by remembering.
 * Appended by the renderer, not written into each template, because a
 * compliance line that can be omitted from one message out of twenty is not a
 * compliance line.
 */
const OPT_OUT_LINE = "Reply STOP to opt out.";

/**
 * The tip link, and the review link only when the product can justify it.
 *
 * The review link is behind a flag that is off. See smsConfig.reviewLinkEnabled
 * for why: nothing in ProFixter records whether a customer has already left a
 * review, so including it would mean asking people who have already done it,
 * over and over. The completion message carries the tip link alone until that
 * changes, which is the whole point of the completion message anyway.
 */
function completionLinks() {
  if (reviewLinkEnabled()) {
    return `Tip your Fixter: ${LINKS.tip} Leave a review: ${LINKS.review}`;
  }
  return `If you would like to leave your Fixter a tip: ${LINKS.tip}`;
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One function per notification type, keyed by that type.
 *
 * Each returns a plain string. Keeping them pure and synchronous is what lets
 * the whole catalogue be rendered and asserted in a test with no database, no
 * network and no provider, which is the only way wording stays correct.
 */
const TEMPLATES = {
  /* ------------------------------ Bookings ----------------------------- */
  BOOKING_CONFIRMED: ({ booking = {} }) =>
    `${BRAND}: your ${visitVocabulary(booking).noun} is confirmed for ${whenPhrase(booking)}. ` +
    `We will text you a reminder beforehand. Questions? Call ${SUPPORT_PHONE}`,

  FREE_VISIT_CONFIRMED: ({ booking = {} }) =>
    `${BRAND}: your free first visit is confirmed for ${whenPhrase(booking)}. ` +
    `There is no charge for this visit. We will text you a reminder beforehand.`,

  ONE_TIME_VISIT_CONFIRMED: ({ booking = {} }) =>
    `${BRAND}: your One-Time Visit is confirmed for ${whenPhrase(booking)}. ` +
    `Your Fixter is booked for 90 minutes. Need to make a change? Call ${SUPPORT_PHONE}`,

  FULL_DAY_CONFIRMED: ({ booking = {} }) =>
    `${BRAND}: your Full Day Service is confirmed for ${formatDateOnly(booking.date)}. ` +
    `Your Fixter is booked for the full workday. We'll send you a reminder beforehand.`,

  /*
   * Both reminders name the date and time outright rather than saying
   * "tomorrow". The 24-hour sweep can legitimately deliver a catch-up reminder
   * as little as two hours before the visit after an outage, and a message
   * that says tomorrow about an appointment happening this afternoon is worse
   * than no message at all.
   *
   * Neither reminder carries a preparation instruction any more. Telling
   * somebody to clear the work area was removed on review and deliberately
   * not replaced: the reminder exists to say when, not to give homework.
   */
  BOOKING_REMINDER_24H: ({ booking = {} }) => {
    const vocab = visitVocabulary(booking);
    return (
      `${BRAND} reminder: your ${vocab.noun} is scheduled for ${whenPhrase(booking)}. ` +
      `Need to make a change? Call ${SUPPORT_PHONE}`
    );
  },

  /*
   * The hour-before reminder states the real arrival policy.
   *
   * "Scheduled to arrive then" was not true and was not approved: a Fixter may
   * arrive up to thirty minutes either side of the booked time, so the message
   * now quotes both the booked time and the window it sits in. The customer
   * gets the commitment we actually make rather than one we do not.
   *
   * A Full Day has no arrival window to quote, because it is the whole
   * workday rather than a slot — so it keeps a plain "starts shortly".
   */
  BOOKING_REMINDER_60M: ({ booking = {} }) => {
    const vocab = visitVocabulary(booking);
    if (vocab.wholeDay) {
      return (
        `${BRAND}: your Full Day Service starts shortly. ` +
        `Your Fixter will be arriving soon.`
      );
    }
    return (
      `${BRAND}: your ${vocab.noun} is coming up. ` +
      `Your Fixter is scheduled for ${formatTimeOnly(booking.date)}, ` +
      `with an arrival window of ${arrivalWindow(booking.date)}.`
    );
  },

  BOOKING_RESCHEDULED: ({ booking = {} }) =>
    `${BRAND}: your ${visitVocabulary(booking).noun} has been rescheduled to ` +
    `${whenPhrase(booking)}. Questions? Call ${SUPPORT_PHONE}`,

  BOOKING_CANCELLED: ({ booking = {} }) =>
    `${BRAND}: your ${visitVocabulary(booking).noun} on ${whenPhrase(booking)} has been cancelled. ` +
    `You can book again anytime at ${SITE}/book`,

  /*
   * The four completion messages.
   *
   * Separate types rather than one with a variable, because the sentence before
   * the link genuinely differs per product and because the audit record should
   * say which kind of visit was completed without needing the booking joined
   * back in. Every one of them ends with the tip link, which is the reason the
   * message exists.
   */
  BOOKING_COMPLETED: ({ booking = {} }) =>
    `Thanks for choosing ${BRAND}! Your visit is complete. ${completionLinks()}`,

  FREE_VISIT_COMPLETED: () =>
    `Thanks for trying ${BRAND}! Your free first visit is complete. ${completionLinks()}`,

  ONE_TIME_VISIT_COMPLETED: () =>
    `Thanks for choosing ${BRAND}! Your One-Time Visit is complete. ${completionLinks()}`,

  FULL_DAY_COMPLETED: () =>
    `Thanks for choosing ${BRAND}! Your Full Day Service is complete. ${completionLinks()}`,

  /* --------------------------- Fixter updates -------------------------- */
  FIXTER_ASSIGNED: ({ booking = {}, fixterName }) =>
    `${BRAND}: ${firstNameOf(fixterName, "Your Fixter")} will be your Fixter for your ` +
    `${visitVocabulary(booking).shortNoun} on ${whenPhrase(booking)}.`,

  FIXTER_CHANGED: ({ booking = {}, fixterName }) =>
    `${BRAND} update: ${firstNameOf(fixterName, "a new Fixter")} will now be your Fixter ` +
    `for your ${visitVocabulary(booking).shortNoun} on ${whenPhrase(booking)}.`,

  /*
   * Reserved. Nothing calls this; there is no dispatch event to call it from.
   * Written now so the shape is settled and the test suite covers it.
   */
  FIXTER_ON_THE_WAY: ({ fixterName }) =>
    `${BRAND}: ${firstNameOf(fixterName, "Your Fixter")} is on the way to you now.`,

  /* ------------------------------ Account ------------------------------ */
  ACCOUNT_CREATED: ({ name }) =>
    `Welcome to ${BRAND}, ${firstNameOf(name)}! Your account is ready. ` +
    `Book a visit anytime at ${SITE}/book. ${OPT_OUT_LINE}`,

  ACCOUNT_PASSWORD_CHANGED: () =>
    `${BRAND} security: your account password was just changed. ` +
    `If this was not you, call ${SUPPORT_PHONE} right away.`,

  /* ---------------------------- Membership ----------------------------- */
  MEMBERSHIP_STARTED: ({ name, planLabel }) => {
    const plan = clean(planLabel, 24);
    return (
      `Welcome to ${BRAND}${plan ? ` ${plan}` : ""}, ${firstNameOf(name)}! ` +
      `Your membership is active. Book your first visit at ${SITE}/book`
    );
  },

  MEMBERSHIP_CHANGED: ({ planLabel, billingCycle }) => {
    const plan = clean(planLabel, 24);
    const cycle = clean(billingCycle, 12);
    return (
      `${BRAND}: your membership is now ${plan || "updated"}${cycle ? `, billed ${cycle}` : ""}. ` +
      `Details are in your account: ${SITE}/account`
    );
  },

  /*
   * Two distinct membership endings, and conflating them would be a lie.
   *
   * Stripe keeps a cancelled subscription active until the period ends. Telling
   * somebody their membership has ended while they still have three weeks of
   * paid visits left would cost us those visits and the goodwill with them.
   */
  MEMBERSHIP_CANCELLATION_SCHEDULED: ({ accessUntil }) => {
    const until = formatDateOnly(accessUntil);
    return (
      `${BRAND}: your membership cancellation is confirmed` +
      `${until ? `. You keep full access until ${until}` : ""}. ` +
      `Changed your mind? ${SITE}/account`
    );
  },

  MEMBERSHIP_CANCELLED: () =>
    `${BRAND}: your membership has now ended. Thank you for being a member. ` +
    `You are welcome back anytime at ${SITE}/membership`,

  PAYMENT_FAILED: () =>
    `${BRAND}: we could not process your membership payment. ` +
    `Please update your card to keep your visits active: ${SITE}/account`,

  /* ----------------------------- Marketing ----------------------------- */
  /*
   * Approved marketing copy, tightened on final review to fit ONE segment.
   *
   * The opt-out line is appended by the renderer, not written here, so the
   * budget these have to fit inside is 160 GSM-7 characters MINUS the 23 that
   * " Reply STOP to opt out." costs. That is the whole reason an earlier
   * draft spilled into a second segment: the copy looked short enough on its
   * own and the compliance line pushed it over. The tests assert the finished
   * length, after the append, for exactly that reason.
   */
  KITCHEN_BATH_MARKETING: () =>
    `${BRAND}: Thinking about a kitchen or bathroom remodel? ` +
    `We handle complete renovations. Get a free estimate: ${SITE}/projects`,

  MEMBERSHIP_MARKETING: () =>
    `${BRAND}: Handyman labor and trip costs are included with membership. ` +
    `Get small home repairs done easily: ${SITE}/membership`,

  /* Copy comes from the campaign document; this is the safety net. */
  SEASONAL_MARKETING: ({ body }) =>
    clean(body, 240) || `${BRAND}: see what is new this season at ${SITE}`,
};

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

const { isMarketing } = require("./smsTypes");

/**
 * Render one notification into the exact string we would send.
 *
 * Three things happen here that deliberately do not happen in the templates:
 *
 *   1. The opt-out line is appended to every marketing message, so no template
 *      can forget it.
 *   2. Whitespace is collapsed, so a template split across source lines for
 *      readability cannot ship a double space.
 *   3. The result is capped. Truncation is a visible bug in a test long before
 *      it is an invisible cost on an invoice.
 */
function renderSms(notificationType, vars = {}) {
  const template = TEMPLATES[notificationType];
  if (typeof template !== "function") {
    throw new Error(`No SMS template for notification type: ${notificationType}`);
  }

  let body = String(template(vars) || "").replace(/\s+/g, " ").trim();

  if (isMarketing(notificationType) && !/reply stop/i.test(body)) {
    body = `${body} ${OPT_OUT_LINE}`;
  }

  if (body.length > MAX_BODY_LENGTH) {
    body = `${body.slice(0, MAX_BODY_LENGTH - 3).trimEnd()}...`;
  }
  return body;
}

function hasTemplate(notificationType) {
  return typeof TEMPLATES[notificationType] === "function";
}

module.exports = {
  ARRIVAL_WINDOW_MS,
  BRAND,
  OPT_OUT_LINE,
  SUPPORT_PHONE,
  TEMPLATES,
  arrivalWindow,
  clean,
  completionLinks,
  firstNameOf,
  formatDateOnly,
  formatDateTime,
  formatTimeOnly,
  hasTemplate,
  renderSms,
  visitVocabulary,
  whenPhrase,
};
