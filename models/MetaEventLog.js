/**
 * One row per Conversions API send attempt (utils/metaCapi.send), so the
 * Overview can say how many Leads, Schedules, Subscribes and Purchases
 * Profixter itself reported to Meta in a period, by kind, and reconcile that
 * with what Ads Manager shows. Before 2026-11-17 nothing was kept: delivery
 * was only an hourly log line, so a past period cannot be rebuilt event by event.
 *
 * NOTHING PERSONAL. No email, phone, name, address, IP, user agent, fbp or
 * fbc - only the event's name, its kind (lead_type / content_name), the event
 * id (a random UUID or a Stripe session id, the same id the browser pixel
 * sends, which is what lets a row be matched to a Request.metaEventId), where
 * the send came from, and the outcome. Kept 400 days.
 */
const mongoose = require("mongoose");

const metaEventLogSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    eventName: { type: String, required: true },
    leadType: { type: String, default: null },
    contentName: { type: String, default: null },
    eventId: { type: String, default: null },
    /* server: sent by a handler that knows the truth (registration, request, Stripe webhook). browser_relay: /api/track/meta. */
    origin: { type: String, enum: ["server", "browser_relay"], default: "server" },
    /* sent | http_error | exception | not_configured | no_identifiers | no_fetch */
    outcome: { type: String, required: true },
    httpStatus: { type: Number, default: null },
    testEvent: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: false, versionKey: false }
);
metaEventLogSchema.index({ at: 1, eventName: 1 });
metaEventLogSchema.index({ eventId: 1 });
metaEventLogSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.models.MetaEventLog || mongoose.model("MetaEventLog", metaEventLogSchema);
