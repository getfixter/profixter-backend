/**
 * Every kind of SMS ProFixter can send.
 *
 * ONE REGISTRY, AND NOTHING SENDS WITHOUT AN ENTRY IN IT.
 *
 * The send path refuses an unknown type. That is what makes this file the
 * complete and honest answer to "what could this system text a customer",
 * rather than a list that drifts out of date the first time somebody adds a
 * message inside a route handler.
 *
 * The classification here is load-bearing, not documentation. channelClass
 * decides which consent rule applies, and getting it wrong is the difference
 * between a service message and an unlawful advertisement. It is declared once,
 * per type, in the same place the type is defined, so a new notification cannot
 * be added without someone answering the question.
 */

const TRANSACTIONAL = "transactional";
const MARKETING = "marketing";

/**
 * @typedef {Object} SmsTypeSpec
 * @property {"transactional"|"marketing"} channelClass Which consent rule applies.
 * @property {boolean} timeCritical True skips the transactional quiet-hour floor.
 *   Only for messages that are worthless if delayed: reminders, and the
 *   confirmations a customer is watching for right after an action they took.
 * @property {string} description What this message is for, in one line.
 */

/** @type {Record<string, SmsTypeSpec>} */
const SMS_TYPES = {
  /* ---------------- Booking lifecycle: membership visits ---------------- */
  BOOKING_CONFIRMED: {
    channelClass: TRANSACTIONAL,
    timeCritical: true,
    description: "A membership visit was booked and confirmed.",
  },
  BOOKING_RESCHEDULED: {
    channelClass: TRANSACTIONAL,
    timeCritical: true,
    description: "A confirmed booking moved to a new date or time.",
  },
  BOOKING_CANCELLED: {
    channelClass: TRANSACTIONAL,
    timeCritical: true,
    description: "A booking was cancelled.",
  },
  BOOKING_REMINDER_24H: {
    channelClass: TRANSACTIONAL,
    timeCritical: true,
    description: "The day-before reminder, for any visit type.",
  },
  BOOKING_REMINDER_60M: {
    channelClass: TRANSACTIONAL,
    timeCritical: true,
    description: "The hour-before reminder, for any visit type.",
  },
  BOOKING_COMPLETED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "A membership visit finished. Carries the tip link.",
  },

  /* ------------------------- Fixter assignment ------------------------- */
  FIXTER_ASSIGNED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "A Fixter was assigned to an upcoming visit.",
  },
  FIXTER_CHANGED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "The Fixter assigned to an upcoming visit changed.",
  },
  /*
   * Registered, and deliberately never triggered by any code path today.
   *
   * There is no on-the-way event in the product: no Fixter app, no dispatch
   * status, nothing that could fire it honestly. It is defined here so that
   * when that event does exist, adding the text is one trigger and one
   * template rather than a change to the type system, and so that nobody
   * invents a second parallel way to send one in the meantime.
   */
  FIXTER_ON_THE_WAY: {
    channelClass: TRANSACTIONAL,
    timeCritical: true,
    description: "Reserved. No trigger exists yet; see the note above.",
  },

  /* ------------------------- Free First Visit -------------------------- */
  FREE_VISIT_CONFIRMED: {
    channelClass: TRANSACTIONAL,
    timeCritical: true,
    description: "A first-visit-free appointment was booked.",
  },
  FREE_VISIT_COMPLETED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "A free first visit finished. Carries the tip link.",
  },

  /* -------------------------- One-Time Visit --------------------------- */
  ONE_TIME_VISIT_CONFIRMED: {
    channelClass: TRANSACTIONAL,
    timeCritical: true,
    description: "A paid one-time visit was booked and paid for.",
  },
  ONE_TIME_VISIT_COMPLETED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "A one-time visit finished. Carries the tip link.",
  },

  /* ----------------------------- Full Day ------------------------------ */
  FULL_DAY_CONFIRMED: {
    channelClass: TRANSACTIONAL,
    timeCritical: true,
    description: "A Full Day visit was booked.",
  },
  FULL_DAY_COMPLETED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "A Full Day visit finished. Carries the tip link.",
  },

  /* -------------------------------- Gift -------------------------------- */
  /*
   * The one message with no alternative channel.
   *
   * Addressed to somebody who has no ProFixter account, may never have given
   * us an email, and cannot otherwise be told that a present is waiting.
   * That is why it has its own switch (GIFT_SMS_ENABLED) and is the only type
   * that switch releases; see sendingAllowedFor in smsConfig.
   *
   * Time-critical: a gift notification that arrives a day late has largely
   * missed its moment, and the purchaser is often standing next to the
   * recipient waiting for the phone to buzz.
   */
  GIFT_INVITATION: {
    channelClass: TRANSACTIONAL,
    timeCritical: true,
    description: "Somebody was given a gift membership. Carries the claim link.",
  },

  /* ------------------------------ Account ------------------------------ */
  ACCOUNT_CREATED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "Welcome text after registration.",
  },
  ACCOUNT_PASSWORD_CHANGED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "Security notice: the account password changed.",
  },

  /* ---------------------------- Membership ----------------------------- */
  MEMBERSHIP_STARTED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "A membership became active.",
  },
  MEMBERSHIP_CHANGED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "A membership plan or billing cycle changed.",
  },
  MEMBERSHIP_CANCELLATION_SCHEDULED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "Cancellation booked; access continues to the period end.",
  },
  MEMBERSHIP_CANCELLED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "A membership actually ended.",
  },
  PAYMENT_FAILED: {
    channelClass: TRANSACTIONAL,
    timeCritical: false,
    description: "A membership payment failed and needs attention.",
  },

  /* ----------------------------- Marketing ----------------------------- */
  KITCHEN_BATH_MARKETING: {
    channelClass: MARKETING,
    timeCritical: false,
    description: "Kitchen and bathroom renovation promotion.",
  },
  MEMBERSHIP_MARKETING: {
    channelClass: MARKETING,
    timeCritical: false,
    description: "Membership promotion to registered non-members.",
  },
  SEASONAL_MARKETING: {
    channelClass: MARKETING,
    timeCritical: false,
    description: "Configurable seasonal or campaign promotion.",
  },
};

/*
 * DELIBERATELY ABSENT: routine renewal and recurring-charge reminders.
 *
 * There is no MEMBERSHIP_RENEWAL_REMINDER, no CARD_CHARGING_TOMORROW and no
 * UPCOMING_PAYMENT type, and their absence is a decision rather than an
 * oversight. ProFixter does not volunteer reminders of routine recurring
 * charges, and the registry is the right place to hold that line: no type
 * means no template, no trigger, and no way to add one without reading this.
 *
 * This suppresses nothing mandatory. Stripe still issues the receipts,
 * invoices and advance notices it is required to on its own channel, and
 * nothing here touches them. PAYMENT_FAILED exists because a failed payment is
 * an actionable problem the customer has to fix, not a routine renewal.
 */

function isKnownType(type) {
  return Object.prototype.hasOwnProperty.call(SMS_TYPES, type);
}

/** The spec for a type. Throws on an unknown one; the send path relies on it. */
function getTypeSpec(type) {
  if (!isKnownType(type)) {
    throw new Error(`Unknown SMS notification type: ${type}`);
  }
  return SMS_TYPES[type];
}

function channelClassOf(type) {
  return getTypeSpec(type).channelClass;
}

function isMarketing(type) {
  return channelClassOf(type) === MARKETING;
}

function isTransactional(type) {
  return channelClassOf(type) === TRANSACTIONAL;
}

function isTimeCritical(type) {
  return getTypeSpec(type).timeCritical === true;
}

function allTypes() {
  return Object.keys(SMS_TYPES);
}

function typesOfClass(channelClass) {
  return allTypes().filter((type) => SMS_TYPES[type].channelClass === channelClass);
}

module.exports = {
  MARKETING,
  SMS_TYPES,
  TRANSACTIONAL,
  allTypes,
  channelClassOf,
  getTypeSpec,
  isKnownType,
  isMarketing,
  isTimeCritical,
  isTransactional,
  typesOfClass,
};
