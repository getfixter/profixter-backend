const mongoose = require("mongoose");

/**
 * The provider webhook this deployment owns.
 *
 * Exists so webhook registration is a managed part of the system rather than a
 * one-off action someone performed once and has to remember: the record is the
 * durable answer to "is our webhook registered, where, and with which events",
 * and it doubles as the claim that prevents two booting instances from
 * registering the same URL twice.
 *
 * Keyed by URL, because the URL is what actually identifies a webhook to the
 * provider - two environments pointing at different hostnames are genuinely
 * different webhooks and both may legitimately exist.
 */

const PROVISION_STATES = Object.freeze(["pending", "active", "failed"]);

const ESignWebhookSchema = new mongoose.Schema(
  {
    provider: { type: String, default: "adobe_sign", required: true, index: true },

    /** The public endpoint Adobe posts to. Unique: one record per endpoint. */
    url: { type: String, required: true, trim: true, immutable: true },

    /** Adobe's webhook id, once registered. */
    providerWebhookId: { type: String, trim: true, default: "" },

    scope: { type: String, trim: true, default: "ACCOUNT" },
    events: { type: [String], default: [] },

    /** Adobe's own state for the webhook: ACTIVE / INACTIVE. */
    providerState: { type: String, trim: true, default: "" },

    /**
     * Our provisioning state, distinct from Adobe's. "pending" is written
     * atomically on insert so a concurrent boot cannot also try to create.
     */
    provisionState: { type: String, enum: PROVISION_STATES, default: "pending", index: true },

    /** Stale-lock detection: a crashed run must not block provisioning forever. */
    provisionStartedAt: { type: Date, default: null },
    lastCheckedAt: { type: Date, default: null },
    lastError: { type: String, trim: true, maxlength: 1000, default: "" },

    /**
     * The client id Adobe will echo in X-AdobeSign-ClientId for this webhook -
     * the id of the application that registered it. Recorded so the value the
     * endpoint must expect is auditable, not folklore. An application id, not
     * a credential.
     */
    expectedClientId: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

ESignWebhookSchema.index({ provider: 1, url: 1 }, { unique: true, name: "unique_provider_url" });

module.exports = mongoose.model("ESignWebhook", ESignWebhookSchema);
module.exports.PROVISION_STATES = PROVISION_STATES;
