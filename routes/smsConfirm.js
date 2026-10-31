const express = require("express");
const { SmsConfirmError, confirmSmsMarketing, describeConfirmation } = require("../utils/consent/smsConfirmLink");

/*
 * The customer's one-click confirmation of offers by text, from the link Admin
 * emails after a call (utils/consent/smsConfirmLink.js). Public: the signed
 * link is the authority. GET only reads; the POST is the consent.
 */
const router = express.Router();

function fail(res, error, label) {
  if (error instanceof SmsConfirmError) return res.status(error.status).json({ code: error.code, message: error.message });
  console.error(label, error);
  return res.status(500).json({ message: "Something went wrong. Nothing was changed." });
}

router.get("/sms-confirm", async (req, res) => {
  try {
    return res.json(await describeConfirmation(String(req.query.t || "")));
  } catch (error) {
    return fail(res, error, "GET /api/consent/sms-confirm error:");
  }
});

router.post("/sms-confirm", async (req, res) => {
  try {
    return res.json(await confirmSmsMarketing({ token: String(req.body?.t || ""), req }));
  } catch (error) {
    return fail(res, error, "POST /api/consent/sms-confirm error:");
  }
});

module.exports = router;
