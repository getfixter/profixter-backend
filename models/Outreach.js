const mongoose = require("mongoose");

/**
 * Postal outreach: the mailable audience and the mail waves.
 *
 * WHY MAIL. The ~60k imported GoHighLevel contacts carry no consent. Texting
 * them is barred by GHL's messaging policy, carrier rules and the TCPA; cold
 * email through GHL's email service breaks its provider's ban on bought lists
 * and risks permanent suspension of the whole CRM. Postal mail needs no prior
 * consent, so the list's real value is its local addresses.
 *
 * OutreachRecipient holds only what a mailing needs (name, address) plus
 * hashes to recognise existing customers - never shown to the agents, which
 * see counts. Each recipient gets a short code that becomes the tracked URL /
 * QR on their postcard (www.profixter.com/m/<wave>-<code>).
 *
 * OutreachWave: a mailing the OWNER plans (towns, size, copy, cost estimate).
 * No agent can create, plan or export one - mail is the owner's own project.
 * Mailing costs money, so a wave is exported only after the owner approves it.
 */
const recipientSchema = new mongoose.Schema(
  {
    ghlContactId: { type: String, required: true, unique: true },
    firstName: { type: String, default: "" },
    lastName: { type: String, default: "" },
    address1: { type: String, default: "" },
    city: { type: String, default: "" },
    state: { type: String, default: "" },
    zip: { type: String, default: "", index: true },
    county: { type: String, default: null },
    householdKey: { type: String, default: null, index: true },
    emailHash: { type: String, default: null, index: true },
    phoneHash: { type: String, default: null, index: true },
    eligible: { type: Boolean, default: false, index: true },
    excludedReason: { type: String, default: null },
    code: { type: String, required: true, unique: true },
    waves: [{ type: String }],
    lastMailedAt: { type: Date, default: null },
    syncedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

const waveSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true }, // short, used in tracked URLs
    name: { type: String, required: true },
    status: { type: String, enum: ["draft", "approved", "exported", "mailed", "cancelled"], default: "draft", index: true },
    targetZips: [{ type: String }],
    size: { type: Number, default: 0 },
    format: { type: String, enum: ["postcard_6x9", "postcard_4x6", "letter"], default: "postcard_6x9" },
    copy: {
      headline: { type: String, default: "" },
      body: { type: String, default: "" },
      callToAction: { type: String, default: "" },
    },
    rationale: { type: String, default: "" },
    estimatedCostCents: { type: Number, default: 0 },
    createdBy: { type: String, default: "" },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    exportedAt: { type: Date, default: null },
    mailedAt: { type: Date, default: null },
    statusNote: { type: String, default: "" },
  },
  { timestamps: true }
);

const OutreachRecipient = mongoose.models.OutreachRecipient || mongoose.model("OutreachRecipient", recipientSchema);
const OutreachWave = mongoose.models.OutreachWave || mongoose.model("OutreachWave", waveSchema);

module.exports = { OutreachRecipient, OutreachWave };
