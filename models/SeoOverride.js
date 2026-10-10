const mongoose = require("mongoose");

/**
 * Live search wording for one page, layered over the defaults in the
 * FrontEnd code (lib/seo-content.ts). The site reads active overrides with
 * incremental regeneration, so a change goes live within minutes without a
 * deploy, and removing the override restores the code default.
 *
 * Written ONLY by the growth engine's seo_page_update action (agent-proposed,
 * trust-laddered, verified on the live page, reversible). `history` keeps
 * every version with the action that made it, so any change can be traced
 * and undone exactly.
 */
const fieldsSchema = new mongoose.Schema(
  {
    metaTitle: { type: String, default: null },
    metaDescription: { type: String, default: null },
    h1: { type: String, default: null },
    intro: { type: String, default: null },
  },
  { _id: false }
);

const seoOverrideSchema = new mongoose.Schema(
  {
    path: { type: String, required: true, unique: true },
    fields: { type: fieldsSchema, default: () => ({}) },
    active: { type: Boolean, default: true, index: true },
    history: [
      {
        _id: false,
        at: Date,
        fields: fieldsSchema,
        previous: fieldsSchema,
        actionId: String,
        by: String,
        reason: String,
      },
    ],
  },
  { timestamps: true }
);

module.exports = mongoose.models.SeoOverride || mongoose.model("SeoOverride", seoOverrideSchema);
