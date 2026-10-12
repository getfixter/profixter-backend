const mongoose = require("mongoose");

/**
 * The last check of one manufacturer media link (image, drawing, guide, CAD).
 *   ok          - the server answered 2xx
 *   broken      - the server answered 4xx/5xx (e.g. 404: the file is gone)
 *   unreachable - no answer (connection refused/reset, timeout) - may be temporary
 */
const StudioMediaCheckSchema = new mongoose.Schema(
  {
    url: { type: String, required: true, unique: true, maxlength: 1000 },
    manufacturer: { type: String, default: "", index: true },
    host: { type: String, default: "" },
    status: { type: String, enum: ["ok", "broken", "unreachable"], required: true, index: true },
    httpStatus: { type: Number, default: null },
    contentType: { type: String, default: "" },
    bytes: { type: Number, default: null },
    error: { type: String, default: "" },
    checkedAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

module.exports = mongoose.models.StudioMediaCheck || mongoose.model("StudioMediaCheck", StudioMediaCheckSchema);
