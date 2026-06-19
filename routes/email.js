const express = require("express");
const router = express.Router();

const EmailSuppression = require("../models/EmailSuppression");
const { readUnsubscribeToken } = require("../utils/unsubscribeToken");

function confirmationHtml(success, message) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Email preferences</title></head><body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#172033;">
<main style="max-width:520px;margin:72px auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;text-align:center;">
<h1 style="font-size:26px;margin:0 0 12px;">${success ? "You are unsubscribed" : "Unable to unsubscribe"}</h1>
<p style="line-height:1.6;color:#475569;">${message}</p>
<a href="https://profixter.com" style="display:inline-block;margin-top:12px;color:#334155;">Return to Profixter</a>
</main></body></html>`;
}

function unsubscribePrompt(token) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Unsubscribe from marketing email</title></head><body style="margin:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#172033;">
<main style="max-width:520px;margin:72px auto;padding:32px;background:#fff;border:1px solid #e5e7eb;border-radius:16px;text-align:center;">
<h1 style="font-size:26px;margin:0 0 12px;">Email preferences</h1>
<p style="line-height:1.6;color:#475569;">Confirm that you want to stop receiving Profixter marketing campaigns.</p>
<form method="post" action="/api/email/unsubscribe">
<input type="hidden" name="token" value="${String(token).replace(/"/g, "&quot;")}">
<button type="submit" style="border:0;border-radius:10px;background:#111827;color:#fff;padding:12px 20px;font-weight:700;cursor:pointer;">Unsubscribe</button>
</form>
</main></body></html>`;
}

router.get("/unsubscribe", (req, res) => {
  try {
    readUnsubscribeToken(req.query.token);
    return res.status(200).type("html").send(unsubscribePrompt(req.query.token));
  } catch (_error) {
    return res
      .status(400)
      .type("html")
      .send(
        confirmationHtml(
          false,
          "This unsubscribe link is invalid or expired. Contact getfixter@gmail.com for help."
        )
      );
  }
});

router.post("/unsubscribe", async (req, res) => {
  try {
    const token = req.query.token || req.body?.token;
    const { email } = readUnsubscribeToken(token);
    await EmailSuppression.findOneAndUpdate(
      { email },
      {
        $set: {
          reason: "unsubscribe",
          source: "campaign_unsubscribe",
          suppressedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return res
      .status(200)
      .type("html")
      .send(
        confirmationHtml(
          true,
          "You will no longer receive Profixter marketing campaigns. Essential account and service messages may still be sent."
        )
      );
  } catch (_error) {
    return res
      .status(400)
      .type("html")
      .send(
        confirmationHtml(
          false,
          "This unsubscribe link is invalid or expired. Contact getfixter@gmail.com for help."
        )
      );
  }
});

module.exports = router;
