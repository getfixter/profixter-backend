const mongoose = require("mongoose");

/**
 * An admin's edit to one communication, stored so it survives a deployment.
 *
 * THE CODE TEMPLATE IS STILL THE PRODUCT. THIS IS AN OVERLAY.
 *
 * Nothing here replaces smsTemplates. A row exists only for a message somebody
 * has deliberately changed, and deleting it - or clearing `active` - returns
 * that message to the tested default. That asymmetry is the safety property:
 * an empty collection means the system behaves exactly as its test suite says,
 * so the blast radius of this whole feature is "the rows that exist".
 *
 * WHY CHANNEL IS A FIELD RATHER THAN A SECOND COLLECTION.
 *
 * Email overrides are not active yet: the email defaults are JavaScript
 * functions producing styled HTML, and turning those into safe editable text is
 * a separate piece of work. But they will be, and a schema that has to be
 * migrated to accommodate that is a schema that discourages doing it properly.
 * The channel field costs nothing now and means the email work is additive.
 *
 * WHAT IS DELIBERATELY NOT HERE: the rendered message. A sent SMS records its
 * own body on SmsMessage at the moment it was sent, and an email records its
 * own snapshot on EmailLog. Editing this row must never reach backwards into
 * those, which is exactly why history lives with the message rather than here.
 */

/**
 * One previous version, kept so a bad edit is one click from undone.
 *
 * Capped rather than unbounded - see the pre-save hook. A template people
 * actually maintain will accumulate revisions forever otherwise, and the
 * hundredth-newest wording of a booking reminder has no operational value.
 */
const RevisionSchema = new mongoose.Schema(
  {
    body: { type: String, default: "" },
    subject: { type: String, default: "" },
    updatedAt: { type: Date, default: Date.now },
    updatedBy: { type: String, default: "" },
    updatedByName: { type: String, default: "" },
  },
  { _id: false }
);

const CommunicationTemplateSchema = new mongoose.Schema(
  {
    /** "sms" or "email". Email rows are reserved and not yet honoured at send. */
    channel: {
      type: String,
      enum: ["sms", "email"],
      required: true,
      index: true,
    },

    /**
     * The notification type for SMS, or the TEMPLATES key for email.
     *
     * Always a key that already exists in code. A row naming a type the code
     * does not know is ignored at render time rather than trusted, so a typo
     * or a stale row after a rename degrades to the default instead of to
     * silence.
     */
    templateKey: { type: String, required: true, trim: true, index: true },

    /** The editable message body, in {{token}} form. */
    body: { type: String, default: "" },

    /** Email only, reserved. SMS has no subject. */
    subject: { type: String, default: "" },

    /**
     * Whether this override is in force.
     *
     * Reset to Default clears it rather than deleting the row, so the revision
     * history and the record that somebody once customised this message both
     * survive the reset.
     */
    active: { type: Boolean, default: true, index: true },

    updatedBy: { type: String, default: "" },
    updatedByName: { type: String, default: "" },

    revisions: { type: [RevisionSchema], default: [] },
  },
  { timestamps: true }
);

/*
 * One override per message, and the database is what enforces it.
 *
 * Two rows for the same template would make "which wording is live?"
 * unanswerable, and whichever one a query happened to return first would win.
 */
CommunicationTemplateSchema.index(
  { channel: 1, templateKey: 1 },
  { unique: true, name: "communication_template_unique_idx" }
);

const MAX_REVISIONS = 20;

CommunicationTemplateSchema.pre("save", function trimRevisions(next) {
  if (this.revisions && this.revisions.length > MAX_REVISIONS) {
    this.revisions = this.revisions.slice(-MAX_REVISIONS);
  }
  next();
});

module.exports = mongoose.model("CommunicationTemplate", CommunicationTemplateSchema);
module.exports.MAX_REVISIONS = MAX_REVISIONS;
