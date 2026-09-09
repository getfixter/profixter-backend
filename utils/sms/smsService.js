const SmsMessage = require("../../models/SmsMessage");
const SmsOptOut = require("../../models/SmsOptOut");

const { BATCH, RETRY, smsEnabled } = require("./smsConfig");
const { checkEligibility } = require("./smsEligibility");
const { estimateSegments, maskPhone, toE164 } = require("./smsPhone");
const { renderSms } = require("./smsTemplates");
const { channelClassOf, getTypeSpec, isMarketing, isTransactional } = require("./smsTypes");
const provider = require("./twilioProvider");

/**
 * The one way to send an SMS.
 *
 * Nothing else in ProFixter may call Twilio, and nothing else may write to the
 * SmsMessage collection. Every send therefore goes through the same eligibility
 * check, the same idempotency claim, the same audit record and the same retry
 * policy, whether it came from a cron sweep, a route handler or a webhook.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN
 *
 *   1. Render first. A template that throws must do so before anything is
 *      claimed or charged, and the rendered body is what gets stored.
 *   2. Claim second, by INSERTING the dedupe key. The insert is the lock. Two
 *      workers racing produce one insert and one duplicate-key error, and the
 *      loser stops without ever asking whether it should have.
 *   3. Check eligibility third, and record the refusal on the claimed row. A
 *      suppressed message is a fact worth keeping: "we deliberately did not
 *      text this person, and here is why" is the answer to most questions an
 *      operator will ever ask this system.
 *   4. Send last, and only then write the provider's receipt.
 *
 * Claiming before checking eligibility is deliberate. It means an opt-out is
 * evaluated once per occurrence rather than re-evaluated on every sweep for the
 * rest of the booking's life, and it means the audit shows the decision.
 */

const MAX_RETRY_ATTEMPTS = RETRY.maxAttempts;

function isDuplicateKeyError(error) {
  return error?.code === 11000 || error?.code === 11001;
}

function truncate(value, max = 300) {
  return String(value === undefined || value === null ? "" : value).slice(0, max);
}

/** Structured, and never carrying a full phone number or a credential. */
function logEvent(event, fields = {}) {
  const line = JSON.stringify({ event, ...fields });
  if (String(event).endsWith("_failed")) console.warn(line);
  else console.log(line);
}

/**
 * When to try again after a transient failure.
 *
 * Widening gaps, and a hard stop. A message that has failed three times over
 * half an hour is not going to succeed on the fourth, and a reminder delivered
 * long after the moment it described is worse than one never delivered at all.
 */
function nextAttemptDelayMs(attempts) {
  const index = Math.max(0, Math.min(attempts - 1, RETRY.backoffMs.length - 1));
  return RETRY.backoffMs[index];
}

/**
 * Record that Twilio already holds an opt-out we did not know about.
 *
 * Twilio maintains its own suppression list and refuses a send to a number on
 * it with error 21610. That happens when a STOP was handled by Twilio without
 * our webhook ever seeing it. Writing it into our own table is what keeps the
 * two in step, so we stop attempting sends that were never going to arrive.
 */
async function recordProviderOptOut(phone, { OptOutModel = SmsOptOut } = {}) {
  const e164 = toE164(phone);
  if (!e164) return;
  await OptOutModel.updateOne(
    { phone: e164 },
    {
      $set: {
        scope: "all",
        source: "twilio_error",
        reason: "Twilio reported the recipient is unsubscribed (21610)",
        optedOutAt: new Date(),
        optedInAt: null,
      },
    },
    { upsert: true }
  ).catch((error) => {
    logEvent("sms_optout_sync_failed", { error: truncate(error?.message) });
  });
}

/**
 * Hand one already-claimed record to the provider.
 *
 * Split out because two callers need exactly this: the first attempt inside
 * enqueueSms, and the retry sweep. Keeping it in one place is what guarantees a
 * retried message obeys the same rules and writes the same fields as a first
 * attempt.
 */
async function deliverClaimedMessage(record, { MessageModel = SmsMessage } = {}) {
  const attempts = Number(record.attempts || 0) + 1;

  await MessageModel.updateOne(
    { _id: record._id },
    {
      $set: {
        status: "sending",
        attemptedAt: new Date(),
        lockExpiresAt: new Date(Date.now() + RETRY.lockStaleMs),
      },
      $inc: { attempts: 1 },
    }
  );

  try {
    const result = await provider.sendMessage({ to: record.toPhone, body: record.body });

    await MessageModel.updateOne(
      { _id: record._id },
      {
        $set: {
          status: "sent",
          sentAt: new Date(),
          providerMessageSid: result.sid,
          providerStatus: result.status,
          providerErrorCode: "",
          providerErrorMessage: "",
          segments: result.numSegments || record.segments || 0,
          nextAttemptAt: null,
          lockExpiresAt: null,
        },
      }
    );

    logEvent("sms_sent", {
      notificationType: record.notificationType,
      channelClass: record.channelClass,
      sid: result.sid,
      to: maskPhone(record.toPhone),
      attempts,
    });
    return { ok: true, status: "sent", sid: result.sid };
  } catch (error) {
    const retryable = Boolean(error?.retryable) && attempts < MAX_RETRY_ATTEMPTS;

    if (provider.isOptOutError(error)) {
      await recordProviderOptOut(record.toPhone);
    }

    await MessageModel.updateOne(
      { _id: record._id },
      {
        $set: {
          status: retryable ? "retry_scheduled" : "failed",
          failedAt: retryable ? null : new Date(),
          providerErrorCode: truncate(error?.providerErrorCode, 20),
          providerErrorMessage: truncate(error?.message),
          suppressionReason: retryable ? "" : truncate(error?.reason, 80),
          nextAttemptAt: retryable ? new Date(Date.now() + nextAttemptDelayMs(attempts)) : null,
          lockExpiresAt: null,
        },
      }
    );

    logEvent("sms_send_failed", {
      notificationType: record.notificationType,
      to: maskPhone(record.toPhone),
      attempts,
      willRetry: retryable,
      providerErrorCode: error?.providerErrorCode || "",
      reason: error?.reason || "",
      message: truncate(error?.message, 200),
    });
    return { ok: false, status: retryable ? "retry_scheduled" : "failed", error };
  }
}

/**
 * Ask for one SMS to be sent.
 *
 * This is the function every trigger calls. It never throws for an ordinary
 * refusal — a duplicate, an opt-out, a missing phone number and a disabled
 * channel are all normal outcomes, and a booking confirmation must not fail
 * because the customer opted out of texts. It returns what happened instead.
 */
async function enqueueSms({
  notificationType,
  dedupeKey,
  user = null,
  phone = null,
  vars = {},
  booking = null,
  subscription = null,
  campaignId = "",
  campaignCycle = 0,
  source = "",
  now = new Date(),
  sendWindow = null,
  MessageModel = SmsMessage,
}) {
  // Throws on an unknown type, deliberately: that is a programming error, not a
  // runtime condition, and it should fail loudly the first time it is run.
  getTypeSpec(notificationType);

  if (!dedupeKey) {
    throw new Error(`enqueueSms requires a dedupeKey for ${notificationType}`);
  }

  const channelClass = channelClassOf(notificationType);
  const body = renderSms(notificationType, vars);
  const e164 = toE164(phone || user?.phone);

  /*
   * The claim. Insert-first, so the unique index on dedupeKey is what
   * arbitrates concurrency rather than a check we performed a moment ago.
   */
  let record;
  try {
    record = await MessageModel.create({
      user: user?._id || null,
      userId: user?.userId || "",
      toPhone: e164 || "",
      recipientName: String(user?.name || booking?.name || "").slice(0, 120),
      booking: booking?._id || null,
      bookingNumber: booking?.bookingNumber || "",
      subscription: subscription?._id || null,
      notificationType,
      channelClass,
      campaignId,
      campaignCycle,
      body,
      segments: estimateSegments(body),
      status: "pending",
      dedupeKey,
      source,
      scheduledFor: now,
    });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      logEvent("sms_duplicate_suppressed", { notificationType, dedupeKey });
      return { ok: false, status: "duplicate", reason: "already_claimed", dedupeKey };
    }
    throw error;
  }

  const eligibility = await checkEligibility({
    notificationType,
    user,
    phone: e164,
    now,
    sendWindow,
  });

  if (!eligibility.eligible) {
    await MessageModel.updateOne(
      { _id: record._id },
      {
        $set: {
          status: "suppressed",
          suppressionReason: truncate(eligibility.reason, 80),
          failedAt: new Date(),
        },
      }
    );
    logEvent("sms_suppressed", {
      notificationType,
      channelClass,
      reason: eligibility.reason,
      detail: eligibility.detail || "",
      to: maskPhone(e164),
    });
    return { ok: false, status: "suppressed", reason: eligibility.reason, id: record._id };
  }

  /*
   * The production safety switch.
   *
   * With SMS_ENABLED unset or false the message is rendered, checked, recorded
   * and then deliberately not sent. The whole system therefore runs in
   * production exactly as it will when live — schedulers evaluate, dedupe keys
   * are claimed, suppressions are recorded, the admin screen fills with real
   * data — while no customer is contacted.
   *
   * The dedupe key stays claimed on purpose. Turning sending on must not
   * release weeks of stale reminders at people whose appointments have already
   * happened; it must start from that moment forward.
   */
  if (!smsEnabled()) {
    await MessageModel.updateOne(
      { _id: record._id },
      { $set: { status: "simulated", suppressionReason: "sms_disabled" } }
    );
    logEvent("sms_simulated", {
      notificationType,
      channelClass,
      to: maskPhone(e164),
      segments: estimateSegments(body),
      bodyPreview: body.slice(0, 80),
    });
    return { ok: true, status: "simulated", id: record._id, body };
  }

  const delivery = await deliverClaimedMessage({ ...record.toObject(), _id: record._id }, { MessageModel });
  return { ...delivery, id: record._id, body };
}

/**
 * Typed entry points.
 *
 * They exist to make the classification impossible to get wrong at the call
 * site: a trigger that believes it is sending a service message and reaches for
 * sendTransactionalSms gets an immediate error if the type is actually
 * marketing, rather than quietly sending an advertisement under service-message
 * consent rules.
 */
async function sendTransactionalSms(options) {
  if (!isTransactional(options.notificationType)) {
    throw new Error(
      `${options.notificationType} is a marketing type; use sendMarketingSms`
    );
  }
  return enqueueSms(options);
}

async function sendMarketingSms(options) {
  if (!isMarketing(options.notificationType)) {
    throw new Error(
      `${options.notificationType} is a transactional type; use sendTransactionalSms`
    );
  }
  return enqueueSms(options);
}

/**
 * Retry messages whose last attempt failed transiently.
 *
 * Also reclaims rows stuck in "sending" past their lock, which is what a worker
 * that died mid-send leaves behind. Without that, one crash would strand a
 * message forever in a state nothing selects.
 */
async function runSmsRetrySweep({
  now = new Date(),
  limit = BATCH.maxPerRun,
  MessageModel = SmsMessage,
} = {}) {
  const stats = { scanned: 0, retried: 0, sent: 0, failed: 0, abandoned: 0, reclaimed: 0 };

  const staleLock = await MessageModel.updateMany(
    { status: "sending", lockExpiresAt: { $lte: now } },
    { $set: { status: "retry_scheduled", nextAttemptAt: now, lockExpiresAt: null } }
  );
  stats.reclaimed = staleLock.modifiedCount || 0;

  const candidates = await MessageModel.find({
    status: "retry_scheduled",
    nextAttemptAt: { $lte: now },
  })
    .sort({ nextAttemptAt: 1 })
    .limit(limit)
    .lean();

  stats.scanned = candidates.length;

  for (const candidate of candidates) {
    if (Number(candidate.attempts || 0) >= MAX_RETRY_ATTEMPTS) {
      await MessageModel.updateOne(
        { _id: candidate._id },
        {
          $set: {
            status: "failed",
            failedAt: new Date(),
            suppressionReason: "max_attempts_exceeded",
            nextAttemptAt: null,
          },
        }
      );
      stats.abandoned += 1;
      continue;
    }

    // Sending was switched off after this row was queued. Leave it alone rather
    // than failing it: it becomes sendable again if sending is switched back on.
    if (!smsEnabled()) break;

    const result = await deliverClaimedMessage(candidate, { MessageModel });
    stats.retried += 1;
    if (result.ok) stats.sent += 1;
    else if (result.status === "failed") stats.failed += 1;

    if (BATCH.delayBetweenSendsMs) {
      await new Promise((resolve) => setTimeout(resolve, BATCH.delayBetweenSendsMs));
    }
  }

  return stats;
}

module.exports = {
  deliverClaimedMessage,
  enqueueSms,
  isDuplicateKeyError,
  nextAttemptDelayMs,
  recordProviderOptOut,
  runSmsRetrySweep,
  sendMarketingSms,
  sendTransactionalSms,
};
