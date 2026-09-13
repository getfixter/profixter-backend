const {
  BRAND,
  OPT_OUT_LINE,
  SUPPORT_PHONE,
  arrivalWindow,
  clean,
  completionLinks,
  firstNameOf,
  formatDateOnly,
  formatTimeOnly,
  visitVocabulary,
  whenPhrase,
} = require("../sms/smsTemplates");

/**
 * The safe, editable form of every SMS the system sends.
 *
 * WHY THIS FILE EXISTS AT ALL.
 *
 * The approved bodies live in smsTemplates as JavaScript functions, which is
 * the right home for them: they are pure, they are tested byte-for-byte, and
 * they can branch on the kind of visit. What they cannot be is edited by a
 * person without a deployment. Handing an admin a JavaScript function to edit
 * would mean either storing executable code - which is a remote code execution
 * hole wearing a friendly name - or accepting that the wording is frozen.
 *
 * So each template gets a mirror here: a plain string with {{token}} holes, and
 * a projection that turns the same vars the code template receives into the
 * values for those holes. Rendering the mirror reproduces the code default
 * exactly, which a test asserts across every visit kind. Once that equivalence
 * holds, an override is just a different string rendered through the same
 * projection, and no code path anywhere gains the ability to run what an admin
 * typed.
 *
 * THE BRANCHING TEMPLATES ARE THE INTERESTING PART.
 *
 * Several messages change shape rather than just wording - the hour-before
 * reminder says something structurally different for a Full Day than for a
 * slot, and the gift invitation reads differently when the sender's name is
 * usable. A token string cannot contain an if. So the projection resolves the
 * branch into a token: "is coming up" versus "starts shortly" arrives as one
 * value, and the single mirror string reproduces both variants. That keeps the
 * editable surface honest - what the admin sees is what renders - without
 * pushing conditionals into content.
 */

/* Values that are the same for every message and are never free text. */
const CONSTANTS = {
  brand: BRAND,
  supportPhone: SUPPORT_PHONE,
  site: "profixter.com",
  optOutLine: OPT_OUT_LINE,
};

/**
 * How each type turns render vars into token values.
 *
 * Every function here is total: a missing booking or a missing name produces
 * the same fallback the code template produces, because both call the same
 * helpers. That is what stops an override rendering "undefined" at somebody.
 */
const DEFINITIONS = {
  /* ------------------------------ Bookings ----------------------------- */
  BOOKING_CONFIRMED: {
    label: "Booking confirmed",
    template:
      "{{brand}}: your {{visitNoun}} is confirmed for {{when}}. " +
      "We will text you a reminder beforehand. Questions? Call {{supportPhone}}",
    tokens: ({ booking = {} }) => ({
      visitNoun: visitVocabulary(booking).noun,
      when: whenPhrase(booking),
    }),
  },

  FREE_VISIT_CONFIRMED: {
    label: "Free first visit confirmed",
    template:
      "{{brand}}: your free first visit is confirmed for {{when}}. " +
      "There is no charge for this visit. We will text you a reminder beforehand.",
    tokens: ({ booking = {} }) => ({ when: whenPhrase(booking) }),
  },

  ONE_TIME_VISIT_CONFIRMED: {
    label: "One-Time Visit confirmed",
    template:
      "{{brand}}: your One-Time Visit is confirmed for {{when}}. " +
      "Your Fixter is booked for 90 minutes. Need to make a change? Call {{supportPhone}}",
    tokens: ({ booking = {} }) => ({ when: whenPhrase(booking) }),
  },

  FULL_DAY_CONFIRMED: {
    label: "Full Day Service confirmed",
    template:
      "{{brand}}: your Full Day Service is confirmed for {{date}}. " +
      "Your Fixter is booked for the full workday. We'll send you a reminder beforehand.",
    tokens: ({ booking = {} }) => ({ date: formatDateOnly(booking.date) }),
  },

  BOOKING_REMINDER_24H: {
    label: "24-hour reminder",
    template:
      "{{brand}} reminder: your {{visitNoun}} is scheduled for {{when}}. " +
      "Need to make a change? Call {{supportPhone}}",
    tokens: ({ booking = {} }) => ({
      visitNoun: visitVocabulary(booking).noun,
      when: whenPhrase(booking),
    }),
  },

  /*
   * The branching one. A Full Day has no arrival window to quote, so the code
   * default writes a different sentence for it. Both variants are reproduced
   * from this single string because the projection resolves the branch.
   */
  BOOKING_REMINDER_60M: {
    label: "60-minute reminder",
    template: "{{brand}}: your {{visitNoun}} {{comingUpPhrase}}. {{fixterTimingSentence}}",
    tokens: ({ booking = {} }) => {
      const vocab = visitVocabulary(booking);
      if (vocab.wholeDay) {
        return {
          visitNoun: "Full Day Service",
          comingUpPhrase: "starts shortly",
          fixterTimingSentence: "Your Fixter will be arriving soon.",
        };
      }
      return {
        visitNoun: vocab.noun,
        comingUpPhrase: "is coming up",
        fixterTimingSentence:
          `Your Fixter is scheduled for ${formatTimeOnly(booking.date)}, ` +
          `with an arrival window of ${arrivalWindow(booking.date)}.`,
      };
    },
  },

  BOOKING_RESCHEDULED: {
    label: "Booking rescheduled",
    template:
      "{{brand}}: your {{visitNoun}} has been rescheduled to {{when}}. " +
      "Questions? Call {{supportPhone}}",
    tokens: ({ booking = {} }) => ({
      visitNoun: visitVocabulary(booking).noun,
      when: whenPhrase(booking),
    }),
  },

  BOOKING_CANCELLED: {
    label: "Booking cancelled",
    template:
      "{{brand}}: your {{visitNoun}} on {{when}} has been cancelled. " +
      "You can book again anytime at {{site}}/book",
    tokens: ({ booking = {} }) => ({
      visitNoun: visitVocabulary(booking).noun,
      when: whenPhrase(booking),
    }),
  },

  /*
   * completionLinks is a token rather than literal text on purpose: it is
   * gated by SMS_REVIEW_LINK_ENABLED, and that gate must not become something
   * an admin can defeat by typing a review URL into the body. See the
   * protected-content list in communicationSettings.
   */
  BOOKING_COMPLETED: {
    label: "Visit completed",
    template: "Thanks for choosing {{brand}}! Your visit is complete. {{completionLinks}}",
    tokens: () => ({ completionLinks: completionLinks() }),
  },

  FREE_VISIT_COMPLETED: {
    label: "Free first visit completed",
    template:
      "Thanks for trying {{brand}}! Your free first visit is complete. {{completionLinks}}",
    tokens: () => ({ completionLinks: completionLinks() }),
  },

  ONE_TIME_VISIT_COMPLETED: {
    label: "One-Time Visit completed",
    template:
      "Thanks for choosing {{brand}}! Your One-Time Visit is complete. {{completionLinks}}",
    tokens: () => ({ completionLinks: completionLinks() }),
  },

  FULL_DAY_COMPLETED: {
    label: "Full Day Service completed",
    template:
      "Thanks for choosing {{brand}}! Your Full Day Service is complete. {{completionLinks}}",
    tokens: () => ({ completionLinks: completionLinks() }),
  },

  /* --------------------------- Fixter updates -------------------------- */
  FIXTER_ASSIGNED: {
    label: "Fixter assigned",
    template:
      "{{brand}}: {{fixterFirstName}} will be your Fixter for your {{visitShortNoun}} on {{when}}.",
    tokens: ({ booking = {}, fixterName }) => ({
      fixterFirstName: firstNameOf(fixterName, "Your Fixter"),
      visitShortNoun: visitVocabulary(booking).shortNoun,
      when: whenPhrase(booking),
    }),
  },

  FIXTER_CHANGED: {
    label: "Fixter changed",
    template:
      "{{brand}} update: {{fixterFirstName}} will now be your Fixter " +
      "for your {{visitShortNoun}} on {{when}}.",
    tokens: ({ booking = {}, fixterName }) => ({
      fixterFirstName: firstNameOf(fixterName, "a new Fixter"),
      visitShortNoun: visitVocabulary(booking).shortNoun,
      when: whenPhrase(booking),
    }),
  },

  FIXTER_ON_THE_WAY: {
    label: "Fixter on the way",
    template: "{{brand}}: {{fixterFirstName}} is on the way to you now.",
    tokens: ({ fixterName }) => ({
      fixterFirstName: firstNameOf(fixterName, "Your Fixter"),
    }),
  },

  /* -------------------------------- Gift ------------------------------- */
  /*
   * Two variants again - named sender versus anonymous - resolved into tokens.
   * The emoji lives in the opener token rather than the editable string, which
   * is why this type keeps its documented Unicode exception without inviting
   * an admin to add more non-GSM-7 characters elsewhere in the body.
   */
  GIFT_INVITATION: {
    label: "Gift invitation",
    template: "{{opener}} {{giftLine}} Open your gift here: {{claimUrl}}",
    tokens: ({ fromName, claimUrl }) => {
      const first = firstNameOf(clean(fromName, 24), "");
      const from = first.length <= 20 ? first : "";
      return {
        opener: from
          ? `You received a gift from ${from} \u{1F381}`
          : `Someone sent you a ${BRAND} Gift Membership \u{1F381}`,
        giftLine: from
          ? `They sent you a ${BRAND} Gift Membership for your home.`
          : "It covers handyman help for your home.",
        claimUrl: String(claimUrl || ""),
      };
    },
  },

  /* ------------------------------ Account ------------------------------ */
  ACCOUNT_CREATED: {
    label: "Account created",
    template:
      "Welcome to {{brand}}, {{firstName}}! Your account is ready. " +
      "Book a visit anytime at {{site}}/book. {{optOutLine}}",
    tokens: ({ name }) => ({ firstName: firstNameOf(name) }),
  },

  ACCOUNT_PASSWORD_CHANGED: {
    label: "Password changed",
    template:
      "{{brand}} security: your account password was just changed. " +
      "If this was not you, call {{supportPhone}} right away.",
    tokens: () => ({}),
  },

  /* ---------------------------- Membership ----------------------------- */
  MEMBERSHIP_STARTED: {
    label: "Membership started",
    template:
      "Welcome to {{brand}}{{planSuffix}}, {{firstName}}! " +
      "Your membership is active. Book your first visit at {{site}}/book",
    tokens: ({ name, planLabel }) => {
      const plan = clean(planLabel, 24);
      return { planSuffix: plan ? ` ${plan}` : "", firstName: firstNameOf(name) };
    },
  },

  MEMBERSHIP_CHANGED: {
    label: "Membership changed",
    template:
      "{{brand}}: your membership is now {{planLabel}}{{cycleSuffix}}. " +
      "Details are in your account: {{site}}/account",
    tokens: ({ planLabel, billingCycle }) => {
      const plan = clean(planLabel, 24);
      const cycle = clean(billingCycle, 12);
      return { planLabel: plan || "updated", cycleSuffix: cycle ? `, billed ${cycle}` : "" };
    },
  },

  MEMBERSHIP_CANCELLATION_SCHEDULED: {
    label: "Membership cancellation scheduled",
    template:
      "{{brand}}: your membership cancellation is confirmed{{accessUntilClause}}. " +
      "Changed your mind? {{site}}/account",
    tokens: ({ accessUntil }) => {
      const until = formatDateOnly(accessUntil);
      return { accessUntilClause: until ? `. You keep full access until ${until}` : "" };
    },
  },

  MEMBERSHIP_CANCELLED: {
    label: "Membership ended",
    template:
      "{{brand}}: your membership has now ended. Thank you for being a member. " +
      "You are welcome back anytime at {{site}}/membership",
    tokens: () => ({}),
  },

  PAYMENT_FAILED: {
    label: "Payment failed",
    template:
      "{{brand}}: we could not process your membership payment. " +
      "Please update your card to keep your visits active: {{site}}/account",
    tokens: () => ({}),
  },

  /* ----------------------------- Marketing ----------------------------- */
  KITCHEN_BATH_MARKETING: {
    label: "Kitchen & bath promotion",
    template:
      "{{brand}}: Thinking about a kitchen or bathroom remodel? " +
      "We handle complete renovations. Get a free estimate: {{site}}/projects",
    tokens: () => ({}),
  },

  MEMBERSHIP_MARKETING: {
    label: "Membership promotion",
    template:
      "{{brand}}: Handyman labor and trip costs are included with membership. " +
      "Get small home repairs done easily: {{site}}/membership",
    tokens: () => ({}),
  },

  /* ------------------------ Lifecycle marketing ----------------------- */
  /*
   * The four texts that accompany the Free First Visit lifecycle. Editable
   * here like any other template; when and whether they send is decided by
   * the lifecycle rules and the consent gates, not by this copy.
   */
  FREE_VISIT_REMINDER: {
    label: "Free visit reminder (Track A, day 4)",
    template:
      "{{brand}}: your first visit is still free, labor and trip included. " +
      "Pick one job and we will handle it: {{site}}/book",
    tokens: () => ({}),
  },

  FREE_VISIT_LAST_CALL: {
    label: "Free visit reminder (Track A, day 30)",
    template:
      "{{brand}}: the free first visit is still on your account. Most people start " +
      "with the thing they walk past every day: {{site}}/book",
    tokens: () => ({}),
  },

  POST_FREE_VISIT_THANKS: {
    label: "After the free visit (Track B, day 3)",
    template:
      "{{brand}}: thanks for having us out. Membership keeps handyman help " +
      "available for whatever comes up next: {{site}}/membership",
    tokens: () => ({}),
  },

  POST_FREE_VISIT_MEMBERSHIP: {
    label: "After the free visit (Track B, day 16)",
    template:
      "{{brand}}: what is next on the list? Membership keeps a Fixter booked in " +
      "regularly, from $149/mo: {{site}}/membership",
    tokens: () => ({}),
  },

  /*
   * The campaign body arrives from the campaign document, so the whole message
   * is one token. An override here changes only the safety net that shows when
   * a campaign has no copy of its own.
   */
  SEASONAL_MARKETING: {
    label: "Seasonal promotion",
    template: "{{campaignBody}}",
    tokens: ({ body }) => ({
      campaignBody: clean(body, 240) || `${BRAND}: see what is new this season at ${CONSTANTS.site}`,
    }),
  },
};

/* -------------------------------------------------------------------------- */
/* Rendering and validation                                                    */
/* -------------------------------------------------------------------------- */

const TOKEN_PATTERN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Whether any brace in the body is not part of a well-formed token.
 *
 * Done by removing every VALID token first and then looking for leftover
 * braces, rather than by one clever pattern. An earlier version tried the
 * clever pattern and rejected `{{brand}}: hello {{when}}` as malformed - its
 * lookbehind fired on the closing braces of a perfectly good token - which
 * would have made the whole editor unusable while looking like strictness.
 * Strip-then-check cannot make that mistake: what is left is, by construction,
 * exactly the part that did not parse.
 */
function findsMalformedBraces(text) {
  const leftover = String(text).replace(TOKEN_PATTERN, "");
  return /\{|\}/.test(leftover);
}

/** Every token name this type may use, constants included. */
function tokensFor(notificationType, sampleVars = {}) {
  const def = DEFINITIONS[notificationType];
  if (!def) return [];
  let dynamic = {};
  try {
    dynamic = def.tokens(sampleVars) || {};
  } catch {
    dynamic = {};
  }
  return [...new Set([...Object.keys(CONSTANTS), ...Object.keys(dynamic)])].sort();
}

/**
 * Build the full token map for one render.
 *
 * Constants last so a projection cannot shadow the brand name or the support
 * number with something a caller passed in.
 */
function buildTokenValues(notificationType, vars = {}) {
  const def = DEFINITIONS[notificationType];
  if (!def) return { ...CONSTANTS };
  let dynamic = {};
  try {
    dynamic = def.tokens(vars) || {};
  } catch {
    dynamic = {};
  }
  return { ...dynamic, ...CONSTANTS };
}

/**
 * Substitute tokens into a template string.
 *
 * A plain replace over a fixed map. There is no expression evaluation, no
 * property path, no function call and no access to anything but the values the
 * projection produced - which is the entire security model and the reason it
 * is this boring.
 */
function renderTokenTemplate(template, values) {
  return String(template || "").replace(TOKEN_PATTERN, (_match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name] ?? "") : ""
  );
}

/**
 * Whether an admin-written body is safe to save.
 *
 * Rejects rather than repairs. A body that silently loses an unknown token is
 * a message with a hole in it that nobody notices until a customer reads it.
 */
function validateTemplate(notificationType, template) {
  const errors = [];
  const def = DEFINITIONS[notificationType];
  if (!def) return { valid: false, errors: [`Unknown notification type: ${notificationType}`] };

  const text = String(template ?? "");
  if (!text.trim()) errors.push("The message body cannot be empty.");

  if (findsMalformedBraces(text)) {
    errors.push("Malformed variable. Every variable must look exactly like {{name}}.");
  }

  const allowed = new Set(tokensFor(notificationType, SAMPLE_VARS[notificationType] || {}));
  const used = new Set();
  let m;
  TOKEN_PATTERN.lastIndex = 0;
  while ((m = TOKEN_PATTERN.exec(text)) !== null) used.add(m[1]);
  for (const name of used) {
    if (!allowed.has(name)) {
      errors.push(`Unknown variable {{${name}}}. Available: ${[...allowed].join(", ")}`);
    }
  }

  return { valid: errors.length === 0, errors, usedTokens: [...used].sort() };
}

/* -------------------------------------------------------------------------- */
/* Sample data for preview                                                     */
/* -------------------------------------------------------------------------- */

const SAMPLE_BOOKING_DATE = new Date("2026-03-03T19:00:00.000Z"); // Tue Mar 3, 2:00 PM ET

const SAMPLE_BOOKINGS = {
  membership: { date: SAMPLE_BOOKING_DATE, bookingNumber: "10000001" },
  free: { date: SAMPLE_BOOKING_DATE, bookingNumber: "10000002", isIntroVisit: true },
  one_time: {
    date: SAMPLE_BOOKING_DATE,
    bookingNumber: "10000003",
    bookingType: "one_time_handyman_visit",
  },
  full_day: { date: SAMPLE_BOOKING_DATE, bookingNumber: "10000004", bookingType: "full_day" },
};

function sampleBookingFor(notificationType) {
  if (/FULL_DAY/.test(notificationType)) return SAMPLE_BOOKINGS.full_day;
  if (/FREE_VISIT/.test(notificationType)) return SAMPLE_BOOKINGS.free;
  if (/ONE_TIME/.test(notificationType)) return SAMPLE_BOOKINGS.one_time;
  return SAMPLE_BOOKINGS.membership;
}

/** The sample values Preview uses. Never touches a real customer record. */
const SAMPLE_VARS = Object.keys(DEFINITIONS).reduce((acc, type) => {
  acc[type] = {
    booking: sampleBookingFor(type),
    name: "Sam Rivera",
    fixterName: "Alex Morgan",
    fromName: "Sam Rivera",
    claimUrl: "https://www.profixter.com/gift/claim/sample-token",
    planLabel: "Premium",
    billingCycle: "monthly",
    accessUntil: new Date("2026-04-01T12:00:00.000Z"),
    body: "",
  };
  return acc;
}, {});

module.exports = {
  CONSTANTS,
  DEFINITIONS,
  SAMPLE_VARS,
  SAMPLE_BOOKINGS,
  buildTokenValues,
  renderTokenTemplate,
  tokensFor,
  validateTemplate,
};
