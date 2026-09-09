const express = require("express");
const router = express.Router();

const SmsMessage = require("../models/SmsMessage");
const SmsOptOut = require("../models/SmsOptOut");
const User = require("../models/User");
const { toE164, maskPhone, userPhoneQuery } = require("../utils/sms/smsPhone");
const { statusCallbackUrl } = require("../utils/sms/smsConfig");
const { validateTwilioSignature, webhookUrlFor } = require("../utils/sms/twilioProvider");
const phoneStatus = require("../utils/sms/smsPhoneStatus");

/**
 * Twilio's two inbound webhooks: delivery status, and replies.
 *
 * PUBLIC BY NECESSITY, AND THEREFORE AUTHENTICATED BY SIGNATURE.
 *
 * Twilio has to be able to reach these, so they cannot sit behind a login. Every
 * request is instead verified against the X-Twilio-Signature header before a
 * single field of the body is trusted. Without that check, anyone who found the
 * URL could mark our messages delivered, or — far worse — post a forged STOP and
 * silence a customer's appointment reminders, or a forged START and un-silence
 * somebody who genuinely opted out.
 *
 * An unverified request is refused with 403 and nothing is written.
 */

/**
 * Confirm the request really came from Twilio.
 *
 * Returns the reason on failure so the log can distinguish a misconfiguration
 * (no auth token set) from an attack (a bad signature). Those want very
 * different responses from whoever reads the logs.
 */
function verifyTwilioRequest(req) {
  const signature = req.headers["x-twilio-signature"];
  const url = webhookUrlFor(req, statusCallbackUrlFor(req));
  return validateTwilioSignature({
    url,
    params: req.body || {},
    signature,
    // Twilio signs with the ACCOUNT auth token, never the API key. See
    // twilioProvider for why the two credentials are kept separate.
  });
}

/**
 * The exact URL Twilio was configured to call, which is what it signed.
 *
 * The status callback is set by us on every send, so we know it precisely. The
 * inbound handler has no such value and falls back to reconstructing the URL
 * from forwarded headers, which is correct behind the load balancer.
 */
function statusCallbackUrlFor(req) {
  const configured = statusCallbackUrl();
  if (!configured) return "";
  if (req.path === "/status") return configured;
  return configured.replace(/\/status$/, req.path);
}

function deny(res, reason) {
  console.warn(JSON.stringify({ event: "sms_webhook_rejected", reason }));
  return res.status(403).type("text/plain").send("Forbidden");
}

/**
 * Twilio expects TwiML, and an empty response is a valid one.
 *
 * Replying with empty TwiML rather than a body is what stops Twilio sending an
 * automatic response of its own on top of whatever we did.
 */
function emptyTwiml(res) {
  return res
    .status(200)
    .type("text/xml")
    .send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
}

/* -------------------------------------------------------------------------- */
/* Delivery status                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How Twilio's message statuses map onto ours.
 *
 * "sent" means the carrier accepted it; "delivered" means the handset confirmed
 * it. Both are successes and are recorded distinctly, because the gap between
 * them is where carrier filtering shows up.
 */
const STATUS_MAP = {
  queued: "sent",
  accepted: "sent",
  sending: "sent",
  sent: "sent",
  delivered: "delivered",
  undelivered: "undelivered",
  failed: "failed",
};

/**
 * A status callback.
 *
 * IDEMPOTENT, BECAUSE TWILIO RETRIES.
 *
 * The same callback can arrive several times, and callbacks for one message can
 * arrive out of order — "delivered" can land before the "sent" that preceded it.
 * So this never moves a message backwards: once delivered, a later "sent"
 * callback is recorded as a no-op rather than downgrading the record.
 */
router.post("/status", async (req, res) => {
  const verdict = verifyTwilioRequest(req);
  if (!verdict.valid) return deny(res, verdict.reason);

  const sid = String(req.body?.MessageSid || req.body?.SmsSid || "").trim();
  const rawStatus = String(req.body?.MessageStatus || req.body?.SmsStatus || "").toLowerCase();
  const errorCode = String(req.body?.ErrorCode || "").trim();

  if (!sid) return emptyTwiml(res);

  const mapped = STATUS_MAP[rawStatus];
  if (!mapped) {
    console.log(JSON.stringify({ event: "sms_status_unknown", sid, rawStatus }));
    return emptyTwiml(res);
  }

  try {
    const now = new Date();
    const update = { providerStatus: rawStatus };
    if (errorCode) update.providerErrorCode = errorCode;

    if (mapped === "delivered") {
      update.status = "delivered";
      update.deliveredAt = now;
    } else if (mapped === "undelivered" || mapped === "failed") {
      update.status = mapped;
      update.failedAt = now;
    }

    /*
     * The guard against out-of-order callbacks. A terminal state is never
     * overwritten by an earlier one; only a message still in flight moves.
     */
    const filter =
      mapped === "sent"
        ? { providerMessageSid: sid, status: { $in: ["pending", "sending"] } }
        : { providerMessageSid: sid, status: { $nin: ["delivered"] } };

    const result = await SmsMessage.updateOne(filter, { $set: update });

    /*
     * Teach the phone-status layer what the carrier just told us.
     *
     * THIS is where "valid" is earned. The provider accepting a message only
     * means Twilio queued it; a delivered callback is a carrier confirming a
     * handset received it, and that is the only evidence good enough to call a
     * number valid.
     *
     * The message row is looked up for its destination rather than trusting
     * the callback's own To field: the record is ours, and it already holds
     * the number we normalised and dialled.
     */
    if (mapped === "delivered" || mapped === "undelivered" || mapped === "failed") {
      const row = await SmsMessage.findOne({ providerMessageSid: sid })
        .select("toPhone notificationType")
        .lean();
      if (row?.toPhone) {
        if (mapped === "delivered") {
          await phoneStatus.markValid(row.toPhone, {
            notificationType: row.notificationType,
          });
        } else {
          await phoneStatus.recordFailure(row.toPhone, {
            code: errorCode,
            reason: rawStatus,
            notificationType: row.notificationType,
          });
        }
      }
    }

    console.log(
      JSON.stringify({
        event: "sms_status_callback",
        sid,
        rawStatus,
        mapped,
        errorCode,
        matched: result.matchedCount,
        modified: result.modifiedCount,
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "sms_status_callback_failed",
        sid,
        error: String(error?.message || "").slice(0, 200),
      })
    );
  }

  return emptyTwiml(res);
});

/* -------------------------------------------------------------------------- */
/* Inbound replies                                                             */
/* -------------------------------------------------------------------------- */

/**
 * This is NOT an inbox, and deliberately never becomes one.
 *
 * ProFixter does not run a conversational SMS number. A customer reply is not a
 * ticket, does not create a conversation and does not notify anybody. The only
 * replies that mean anything are the compliance keywords, and everything else
 * is acknowledged and dropped.
 *
 * The keyword lists match the ones carriers and Twilio recognise. Twilio's
 * Advanced Opt-Out handles these itself when a Messaging Service is configured,
 * and that is fine: we are not trying to be the enforcement point, we are
 * keeping our own state synchronised so our eligibility checks agree with
 * Twilio's rather than repeatedly attempting sends it will refuse.
 */
const STOP_WORDS = new Set([
  "stop", "stopall", "unsubscribe", "cancel", "end", "quit", "stop all", "optout", "opt out",
]);
const START_WORDS = new Set(["start", "unstop", "yes", "optin", "opt in"]);
const HELP_WORDS = new Set(["help", "info"]);

function normalizeKeyword(body) {
  return String(body || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

router.post("/inbound", async (req, res) => {
  const verdict = verifyTwilioRequest(req);
  if (!verdict.valid) return deny(res, verdict.reason);

  const from = toE164(req.body?.From);
  const keyword = normalizeKeyword(req.body?.Body);

  if (!from) return emptyTwiml(res);

  try {
    if (STOP_WORDS.has(keyword)) {
      await applyOptOut(from, keyword);
      console.log(
        JSON.stringify({ event: "sms_opt_out", from: maskPhone(from), keyword })
      );
    } else if (START_WORDS.has(keyword)) {
      await applyOptIn(from, keyword);
      console.log(
        JSON.stringify({ event: "sms_opt_in", from: maskPhone(from), keyword })
      );
    } else if (HELP_WORDS.has(keyword)) {
      // Twilio answers HELP itself with the registered brand response. Recorded
      // only, so the log shows the request arrived.
      console.log(JSON.stringify({ event: "sms_help_request", from: maskPhone(from) }));
    } else {
      /*
       * An ordinary reply. Logged without its content: this is not a support
       * channel, we did not ask for the message, and storing the text of
       * something a customer sent to a number we told them not to converse on
       * would be collecting data we have no use for.
       */
      console.log(JSON.stringify({ event: "sms_inbound_ignored", from: maskPhone(from) }));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "sms_inbound_failed",
        from: maskPhone(from),
        error: String(error?.message || "").slice(0, 200),
      })
    );
  }

  return emptyTwiml(res);
});

/**
 * Record a STOP.
 *
 * Upsert on the phone, and mirror it onto every account that uses that number
 * so the account screen tells the truth too. The opt-out row is what the
 * eligibility check reads; the user fields are for people looking at a customer.
 */
async function applyOptOut(phone, keyword) {
  const now = new Date();
  await SmsOptOut.updateOne(
    { phone },
    {
      $set: {
        scope: "all",
        source: "carrier_keyword",
        keyword: String(keyword || "").slice(0, 20),
        optedOutAt: now,
        optedInAt: null,
      },
    },
    { upsert: true }
  );

  /*
   * Every account on this handset, not just the one whose phone happens to be
   * spelled in E.164. Several people can legitimately share a number, and a
   * STOP has to be visible on all of their accounts.
   */
  const accounts = userPhoneQuery(phone);
  if (accounts) await User.updateMany(
    accounts,
    {
      $set: {
        "smsPreferences.marketingEnabled": false,
        "smsPreferences.optedOutAt": now,
        "smsPreferences.optOutSource": "sms_stop_keyword",
      },
    }
  );
}

/**
 * Record a START.
 *
 * Resolves the opt-out by stamping optedInAt, which is why the row is kept
 * rather than deleted: the history of a number that opted out and back in is
 * exactly the record you want if consent is ever disputed.
 *
 * NOTE WHAT THIS DOES NOT DO. It restores service messaging only. Marketing
 * stays off, because START is a reply to a service message and is not the
 * express written consent that promotional texting requires. Somebody who wants
 * marketing again has to opt in through the account, where we can record how
 * and when.
 */
async function applyOptIn(phone, keyword) {
  const now = new Date();
  await SmsOptOut.updateOne(
    { phone },
    {
      $set: {
        keyword: String(keyword || "").slice(0, 20),
        optedInAt: now,
      },
      $setOnInsert: { scope: "all", source: "carrier_keyword", optedOutAt: now },
    },
    { upsert: true }
  );

  /*
   * Every account on this handset, not just the one whose phone happens to be
   * spelled in E.164. Several people can legitimately share a number, and a
   * STOP has to be visible on all of their accounts.
   */
  const accounts = userPhoneQuery(phone);
  if (accounts) await User.updateMany(
    accounts,
    { $set: { "smsPreferences.optedOutAt": null, "smsPreferences.optOutSource": "" } }
  );
}

module.exports = router;
module.exports.applyOptIn = applyOptIn;
module.exports.applyOptOut = applyOptOut;
module.exports.normalizeKeyword = normalizeKeyword;
module.exports.STATUS_MAP = STATUS_MAP;
