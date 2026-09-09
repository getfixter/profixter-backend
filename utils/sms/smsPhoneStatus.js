const SmsPhoneStatus = require("../../models/SmsPhoneStatus");
const { maskPhone, toE164 } = require("./smsPhone");

/**
 * Deliverability state for a phone number.
 *
 * The rule this module exists to enforce: we stop texting a number only when a
 * carrier has told us, permanently, that the NUMBER cannot receive our
 * messages. Not when a send failed. Not when Twilio had a bad minute. Not when
 * a carrier filtered one message. Silencing a real customer forever is a worse
 * outcome than a handful of wasted sends, so every ambiguous case is resolved
 * in favour of keeping the number.
 */

/**
 * The provider errors that prove the DESTINATION NUMBER is at fault.
 *
 * A deliberately short list, drawn from the permanent set the retry layer
 * already classifies. Being permanent is not enough to appear here: the
 * failure also has to be a fact about the number itself rather than about our
 * account, our content, or one carrier's mood.
 */
const UNDELIVERABLE_CODES = {
  21211: "invalid_phone_number",
  21214: "invalid_phone_number",
  21217: "invalid_phone_number",
  21612: "unreachable_route",
  21614: "not_a_mobile_number",
  30005: "unknown_destination",
  30006: "landline_or_unreachable",
};

/**
 * Permanent failures that are deliberately NOT treated as the number's fault.
 *
 * Each of these stops the individual message - the retry layer already refuses
 * to try again - but none of them is evidence that the number is dead, and
 * marking it so would permanently silence somebody we could still reach.
 * Written out rather than merely omitted, because the reasoning is the point
 * and the next person to read this list will be tempted to add them.
 *
 *   21610  The recipient opted out. Their phone works perfectly. This belongs
 *          to SmsOptOut, and conflating consent with deliverability would make
 *          a STOP look like a broken handset.
 *   21408  Our account is not permitted to send to that region. Our problem,
 *          not theirs, and it resolves the moment the region is enabled.
 *   30003  "Unreachable destination handset" - which is also what a switched
 *          off phone, or one in a tunnel, looks like. Genuinely ambiguous, so
 *          the number keeps the benefit of the doubt.
 *   30004  The message was blocked. Usually a block on the sender or the
 *          content, not a defect in the number.
 *   30007  Carrier filtering. This is about OUR reputation and content. If it
 *          marked numbers dead, one bad campaign would burn the whole list.
 *   30008  Unknown delivery error. Generic by definition; guessing from it is
 *          exactly what this module refuses to do.
 */
const PERMANENT_BUT_NOT_NUMBER_FAULT = {
  21610: "recipient_opted_out",
  21408: "region_not_enabled",
  30003: "handset_unreachable",
  30004: "message_blocked",
  30007: "carrier_filtered",
  30008: "unknown_delivery_error",
};

function isUndeliverableCode(code) {
  return Object.prototype.hasOwnProperty.call(UNDELIVERABLE_CODES, Number(code));
}

function logEvent(event, fields = {}) {
  console.log(JSON.stringify({ event, ...fields }));
}

/**
 * The current state of a number.
 *
 * A number with no row is "unknown", which is why nothing has to create a row
 * up front and why a newly changed phone starts clean without any reset step.
 */
async function getPhoneStatus(phone, { Model = SmsPhoneStatus } = {}) {
  const e164 = toE164(phone);
  if (!e164) return { phone: null, status: "unknown", known: false };
  const row = await Model.findOne({ phone: e164 }).lean();
  if (!row) return { phone: e164, status: "unknown", known: false };
  return { ...row, known: true };
}

/** Whether we should refuse to attempt a send at all. */
async function isUndeliverable(phone, { Model = SmsPhoneStatus } = {}) {
  const state = await getPhoneStatus(phone, { Model });
  return state.status === "undeliverable";
}

/**
 * A carrier confirmed delivery.
 *
 * Only ever called from the delivery status callback, never from "the provider
 * accepted the message" - acceptance means Twilio queued it, which is not the
 * same as a handset receiving it, and treating it as proof would mark dead
 * numbers valid.
 *
 * A confirmed delivery also CLEARS an undeliverable mark. That matters for
 * recycled numbers: a dead line reassigned to a new subscriber starts working
 * again, and the evidence in front of us beats the evidence from before.
 */
async function markValid(phone, { notificationType = "", Model = SmsPhoneStatus } = {}) {
  const e164 = toE164(phone);
  if (!e164) return null;

  const now = new Date();
  await Model.updateOne(
    { phone: e164 },
    {
      $set: {
        status: "valid",
        lastSuccessAt: now,
        undeliverableAt: null,
        undeliverableCode: "",
        undeliverableReason: "",
        lastNotificationType: String(notificationType || "").slice(0, 60),
      },
      $inc: { successCount: 1 },
    },
    { upsert: true }
  ).catch((error) => {
    logEvent("sms_phone_status_write_failed", {
      action: "markValid",
      to: maskPhone(e164),
      error: String(error?.message || "").slice(0, 200),
    });
  });

  return e164;
}

/**
 * Record a failure, and decide whether it condemns the number.
 *
 * One entry point for every failure so the decision is made in one place from
 * the provider's own error code, rather than at each call site from whatever
 * happened to be in scope. Returns whether the number was marked
 * undeliverable, so the caller can log it.
 */
async function recordFailure(
  phone,
  { code = "", reason = "", notificationType = "", Model = SmsPhoneStatus } = {}
) {
  const e164 = toE164(phone);
  if (!e164) return { marked: false, reason: "no_valid_phone" };

  const now = new Date();
  const condemns = isUndeliverableCode(code);

  const update = {
    $set: {
      lastFailureAt: now,
      lastFailureCode: String(code || "").slice(0, 20),
      lastFailureReason: String(reason || "").slice(0, 80),
      lastNotificationType: String(notificationType || "").slice(0, 60),
    },
    $inc: { failureCount: 1 },
    $setOnInsert: { status: "unknown" },
  };

  if (condemns) {
    /*
     * $setOnInsert cannot coexist with $set on the same field, so the status
     * is only moved here, on the branch that actually changes it.
     */
    delete update.$setOnInsert;
    update.$set.status = "undeliverable";
    update.$set.undeliverableAt = now;
    update.$set.undeliverableCode = String(code || "").slice(0, 20);
    update.$set.undeliverableReason = UNDELIVERABLE_CODES[Number(code)] || reason || "";
  }

  await Model.updateOne({ phone: e164 }, update, { upsert: true }).catch((error) => {
    logEvent("sms_phone_status_write_failed", {
      action: "recordFailure",
      to: maskPhone(e164),
      error: String(error?.message || "").slice(0, 200),
    });
  });

  if (condemns) {
    logEvent("sms_phone_undeliverable", {
      to: maskPhone(e164),
      code: String(code),
      reason: UNDELIVERABLE_CODES[Number(code)],
      notificationType,
    });
  }

  return { marked: condemns, reason: condemns ? UNDELIVERABLE_CODES[Number(code)] : "transient_or_unrelated" };
}

/**
 * Put a number back into play by hand.
 *
 * For the case the automation cannot see: a customer rings up to say the text
 * never arrived, somebody checks, and the number is fine. Resetting to unknown
 * rather than valid is deliberate - an operator saying "this looks right"
 * is not a carrier confirming delivery, and the next successful send will
 * supply that.
 */
async function clearUndeliverable(phone, { Model = SmsPhoneStatus } = {}) {
  const e164 = toE164(phone);
  if (!e164) return null;
  await Model.updateOne(
    { phone: e164 },
    {
      $set: {
        status: "unknown",
        undeliverableAt: null,
        undeliverableCode: "",
        undeliverableReason: "",
      },
    },
    { upsert: true }
  );
  logEvent("sms_phone_undeliverable_cleared", { to: maskPhone(e164) });
  return e164;
}

module.exports = {
  PERMANENT_BUT_NOT_NUMBER_FAULT,
  UNDELIVERABLE_CODES,
  clearUndeliverable,
  getPhoneStatus,
  isUndeliverable,
  isUndeliverableCode,
  markValid,
  recordFailure,
};
