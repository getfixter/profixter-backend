const mongoose = require("mongoose");

/**
 * A follow-up email written by an agent for one predefined audience segment.
 *
 * The agent drafts it; the OWNER approves the wording (once); from then on the
 * growth engine decides, under its trust ladder, whether each send is only
 * recorded, waits for approval, or runs on its own. A playbook can never be
 * approved by an agent, never targets anyone outside its segment, never
 * carries a discount (utils/agents/copyRules), and every send obeys the
 * marketing email rules (marketable account, not unsubscribed, one-click
 * unsubscribe, frequency cap) - see utils/growth/actions/playbookEmail.js.
 *
 * Changing the wording of an approved playbook sends it back to draft.
 */
const SEGMENTS = ["free_visit_undecided", "registered_never_booked", "cancellation_scheduled", "former_member_recent"];

const emailPlaybookSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    segment: { type: String, enum: SEGMENTS, required: true },
    purpose: { type: String, default: "" },
    measure: { type: String, default: "" },
    subject: { type: String, required: true },
    preheader: { type: String, default: "" },
    headline: { type: String, required: true },
    paragraphs: [{ type: String }],
    ctaLabel: { type: String, required: true },
    ctaRoute: { type: String, required: true },
    closing: { type: String, default: "" },
    status: { type: String, enum: ["draft", "approved", "retired"], default: "draft", index: true },
    version: { type: Number, default: 1 },
    createdBy: { type: String, default: "" },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    approvedVersion: { type: Number, default: null },
    retiredAt: { type: Date, default: null },
    statusNote: { type: String, default: "" },
  },
  { timestamps: true }
);

emailPlaybookSchema.statics.SEGMENTS = SEGMENTS;

module.exports = mongoose.models.EmailPlaybook || mongoose.model("EmailPlaybook", emailPlaybookSchema);
