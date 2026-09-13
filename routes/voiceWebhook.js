const express = require("express");
const router = express.Router();

const { twilioCredentials } = require("../utils/sms/smsConfig");
const { validateTwilioSignature } = require("../utils/sms/twilioProvider");

/**
 * What happens when somebody rings the notification number.
 *
 * 631-888-6340 sends appointment reminders. It is not a phone line: there is
 * no desk behind it, no rota, no voicemail box anybody empties. Until now
 * there was also no answer - Twilio had nowhere to send a call, so a customer
 * who rang the number printed in their reminder got a carrier error and drew
 * the obvious conclusion about the company that sent it.
 *
 * So this answers, says where the humans are, and hangs up. That is the whole
 * feature, and the list of things it deliberately does not do is longer than
 * the list of things it does:
 *
 *   - It never rings an employee or a Fixter. There is no dial verb here.
 *   - It never records. No <Record>, so nothing is captured and nothing has to
 *     be retained, disclosed or deleted later.
 *   - It never takes a voicemail, queues, or forwards.
 *   - It never calls anybody back.
 *
 * A caller hears one sentence pointing at 631-599-1363 and the call ends. If
 * they need help they now know the number that reaches a person, which is more
 * than the old behaviour gave them.
 *
 * TwiML is XML, and the announcement is a fixed string in this file rather
 * than anything derived from the request, so there is no path by which caller
 * data could be echoed into the response.
 */

const SUPPORT_PHONE = "631-599-1363";

const ANNOUNCEMENT =
  "This number is used only for automated ProFixter notifications and does not accept calls. " +
  `For assistance, please call ${SUPPORT_PHONE.split("-").join(" ")}.`;

/**
 * Say it twice, slowly, then stop.
 *
 * A phone number heard once while somebody is realising they rang the wrong
 * line is a phone number nobody writes down. The repeat costs three seconds
 * and is the difference between the message working and merely being correct.
 */
function announcementTwiml() {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    "<Response>" +
    `<Say voice="alice">${ANNOUNCEMENT}</Say>` +
    "<Pause length=\"1\"/>" +
    `<Say voice="alice">${ANNOUNCEMENT}</Say>` +
    "<Hangup/>" +
    "</Response>"
  );
}

/**
 * The URL Twilio signed for a voice call.
 *
 * Same reasoning as the SMS webhooks: behind the load balancer the protocol
 * and host Express sees are internal, so the public base URL is preferred and
 * the forwarded headers are the fallback.
 */
function voiceUrlFor(req) {
  const base = String(process.env.PUBLIC_API_URL || process.env.PUBLIC_API_BASE_URL || "").replace(
    /\/+$/,
    ""
  );
  if (base) return `${base}/api/voice/webhook${req.path}`;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "";
  return host ? `${proto}://${host}${req.originalUrl.split("?")[0]}` : "";
}

/**
 * Verified like the SMS webhooks, and refused the same way.
 *
 * This endpoint is public because Twilio has to reach it, so the signature is
 * what makes it ours. An unsigned request gets 403 and no TwiML: without the
 * check, anyone who found the URL could make our number announce whatever a
 * future edit allowed into the response, and could bill us for the attempt.
 *
 * Fails closed when the auth token is missing, exactly as the SMS side does.
 */
router.post("/inbound", (req, res) => {
  const verdict = validateTwilioSignature({
    url: voiceUrlFor(req),
    params: req.body || {},
    signature: req.headers["x-twilio-signature"],
    authToken: twilioCredentials().authToken,
  });

  if (!verdict.valid) {
    console.warn(JSON.stringify({ event: "voice_webhook_rejected", reason: verdict.reason }));
    return res.status(403).type("text/plain").send("Forbidden");
  }

  console.log(
    JSON.stringify({
      event: "voice_inbound_announced",
      /* The call SID identifies the call to Twilio. The caller's number is not logged. */
      callSid: String(req.body?.CallSid || "").slice(0, 40),
    })
  );

  return res.status(200).type("text/xml").send(announcementTwiml());
});

module.exports = router;
module.exports.ANNOUNCEMENT = ANNOUNCEMENT;
module.exports.announcementTwiml = announcementTwiml;
