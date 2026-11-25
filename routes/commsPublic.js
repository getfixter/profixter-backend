const express = require("express");
const { CommMediaUpload } = require("../models/Comms");
const media = require("../utils/comms/media");
const { isObjectId } = require("../utils/comms/core");

/**
 * The one public Communications URL: the picture Twilio fetches to deliver an
 * outbound MMS. It needs an HMAC signature that expires in two hours
 * (utils/comms/media.js) and serves exactly one image; anything else is 404.
 */
const router = express.Router();

router.get("/media/:id", async (req, res) => {
  try {
    if (!isObjectId(req.params.id) || !media.verifySignedMedia(req.params.id, req.query.exp, req.query.sig)) return res.status(404).end();
    const row = await CommMediaUpload.findById(req.params.id).select("key contentType").lean();
    if (!row) return res.status(404).end();
    const buffer = await media.readObject(row.key);
    res.set({ "Content-Type": row.contentType, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    return res.send(buffer);
  } catch {
    return res.status(404).end();
  }
});

module.exports = router;
