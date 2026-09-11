const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();

const auth = require("../middleware/auth");
const { PERMISSIONS, requirePermission } = require("../middleware/authorize");
const CommunicationTemplate = require("../models/CommunicationTemplate");
const EmailLog = require("../models/EmailLog");
const SmsMessage = require("../models/SmsMessage");
const User = require("../models/User");

const { TEMPLATES: EMAIL_TEMPLATES } = require("../utils/emailService");
const { TEMPLATES: SMS_CODE_TEMPLATES, renderSms } = require("../utils/sms/smsTemplates");
const { SMS_TYPES } = require("../utils/sms/smsTypes");
const { estimateSegments, isUnicodeBody, maskPhone } = require("../utils/sms/smsPhone");
const { MAX_BODY_LENGTH } = require("../utils/sms/smsConfig");
const {
  DEFINITIONS,
  SAMPLE_VARS,
  buildTokenValues,
  renderTokenTemplate,
  tokensFor,
  validateTemplate,
} = require("../utils/communications/smsTokens");
const overrides = require("../utils/communications/templateOverrides");
const {
  PROTECTED_CONTENT,
  emailSettingsFor,
  smsSettingsFor,
} = require("../utils/communications/communicationSettings");
const emailMarkup = require("../utils/communications/emailMarkup");
const {
  EMAIL_DEFINITIONS,
  SAMPLE_EMAIL_VARS,
  buildEmailTokens,
  emailTokenNames,
  protectedTokensFor,
} = require("../utils/communications/emailTokens");
const { NON_REGISTRY_EMAILS } = require("../utils/communications/emailCatalogue");

/**
 * Admin control over what the system says to customers.
 *
 * EDITING IS ADMIN-ONLY AND SO IS READING. Message bodies contain customer
 * names, appointment times and claim links; the history endpoints return what
 * was actually sent to a named person. Both sides of this router therefore sit
 * behind the same ADMIN permission the rest of the admin API uses.
 *
 * PREVIEW NEVER SENDS. There is no code path from this file to Twilio or to the
 * mail transport. Preview renders a string from sample data and returns it,
 * which is the only way a preview endpoint should ever work: a "send test"
 * button on a screen whose whole purpose is editing unproven copy is how a
 * half-written message reaches a real customer.
 */

const onlyAdmin = requirePermission(PERMISSIONS.ADMIN);

function adminIdentity(req) {
  return {
    updatedBy: String(req.user?.id || ""),
    updatedByName: String(req.user?.name || req.user?.email || ""),
  };
}

/** Everything the editor needs to describe one body's cost and encoding. */
function measure(body) {
  const text = String(body || "");
  const unicode = isUnicodeBody(text);
  const segments = estimateSegments(text);
  return {
    characters: text.length,
    encoding: unicode ? "UCS-2" : "GSM-7",
    unicode,
    segments,
    maxLength: MAX_BODY_LENGTH,
    multiSegment: segments > 1,
  };
}

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Render one SMS type's default without consulting any override.
 *
 * Calls the code template directly rather than renderSms, because renderSms is
 * exactly the function that applies an override - and "what would this say if I
 * reset it?" has to be answerable while an override is in force.
 */
function renderCodeDefault(notificationType, vars) {
  const fn = SMS_CODE_TEMPLATES[notificationType];
  if (typeof fn !== "function") return "";
  return String(fn(vars) || "").replace(/\s+/g, " ").trim();
}

async function smsCatalogue() {
  const rows = await CommunicationTemplate.find({ channel: "sms" }).lean();
  const byKey = new Map(rows.map((r) => [r.templateKey, r]));

  return Object.keys(SMS_TYPES).map((type) => {
    const def = DEFINITIONS[type] || {};
    const row = byKey.get(type);
    const active = Boolean(row?.active && String(row.body || "").trim());
    const sample = SAMPLE_VARS[type] || {};
    const effective = active
      ? renderTokenTemplate(row.body, buildTokenValues(type, sample))
      : renderCodeDefault(type, sample);
    const settings = smsSettingsFor(type);

    return {
      channel: "sms",
      templateKey: type,
      label: def.label || type,
      description: settings.description,
      channelClass: settings.channelClass,
      reserved: settings.reserved,
      editable: true,
      defaultBody: def.template || "",
      body: active ? row.body : def.template || "",
      hasOverride: active,
      updatedAt: row?.updatedAt || null,
      updatedByName: row?.updatedByName || "",
      revisionCount: row?.revisions?.length || 0,
      variables: tokensFor(type, sample),
      preview: { body: effective, ...measure(effective) },
    };
  });
}

async function emailCatalogue() {
  const rows = await CommunicationTemplate.find({ channel: "email" }).lean();
  const byKey = new Map(rows.map((r) => [r.templateKey, r]));

  const registered = Object.keys(EMAIL_TEMPLATES)
    .sort()
    .map((key) => {
      const def = EMAIL_DEFINITIONS[key];
      const settings = emailSettingsFor(key);
      const row = byKey.get(key);
      const active = Boolean(row?.active && String(row.body || "").trim());

      let codeSubject = "";
      try {
        codeSubject = String(EMAIL_TEMPLATES[key](SAMPLE_EMAIL_VARS).subject || "");
      } catch {
        codeSubject = "";
      }

      return {
        channel: "email",
        templateKey: key,
        label: def?.label || settings.label,
        channelClass: def?.channelClass || settings.channelClass,
        /*
         * Only templates with a token definition can be edited. A registered
         * template without one would give the editor an empty variable list and
         * no way to reproduce its dynamic values, which is worse than saying so.
         */
        editable: Boolean(def),
        editableNote: def ? "" : settings.editableNote,
        disposition: def ? "editable" : "visible",
        subject: active ? row.subject : codeSubject,
        codeSubject,
        body: active ? row.body : "",
        hasOverride: active,
        updatedAt: row?.updatedAt || null,
        updatedByName: row?.updatedByName || "",
        revisionCount: row?.revisions?.length || 0,
        variables: def ? emailTokenNames(key) : [],
        protectedTokens: protectedTokensFor(key),
      };
    });

  /*
   * Everything sent through sendRaw or sendPromo, listed so no email type is
   * invisible to Admin. Not editable: their bodies are assembled at the call
   * site or are generated documents. See utils/communications/emailCatalogue.
   */
  const nonRegistry = Object.entries(NON_REGISTRY_EMAILS).map(([key, info]) => ({
    channel: "email",
    templateKey: key,
    label: info.label,
    channelClass: info.channelClass,
    editable: false,
    disposition: info.disposition,
    category: info.category,
    audience: info.audience,
    trigger: info.trigger,
    source: info.source,
    protectedNote: info.protectedNote || "",
    dynamic: Boolean(info.dynamic),
    subject: "",
    hasOverride: false,
    variables: [],
  }));

  return [...registered, ...nonRegistry];
}

router.get("/templates", auth, ...onlyAdmin, async (req, res) => {
  try {
    const channel = String(req.query.channel || "").trim();
    const payload = { protectedContent: PROTECTED_CONTENT };
    if (channel !== "email") payload.sms = await smsCatalogue();
    if (channel !== "sms") payload.email = await emailCatalogue();
    return res.json(payload);
  } catch (error) {
    console.error("Communication template list failed:", error);
    return res.status(500).json({ message: "Failed to load communication templates" });
  }
});

router.get("/templates/:channel/:templateKey", auth, ...onlyAdmin, async (req, res) => {
  try {
    const { channel, templateKey } = req.params;

    if (channel === "sms") {
      if (!SMS_TYPES[templateKey]) return res.status(404).json({ message: "Unknown SMS type" });
      const list = await smsCatalogue();
      const item = list.find((r) => r.templateKey === templateKey);
      const row = await CommunicationTemplate.findOne({ channel: "sms", templateKey }).lean();
      return res.json({
        item,
        settings: smsSettingsFor(templateKey),
        revisions: (row?.revisions || []).slice().reverse(),
      });
    }

    if (channel === "email") {
      const list = await emailCatalogue();
      const item = list.find((r) => r.templateKey === templateKey);
      if (!item) return res.status(404).json({ message: "Unknown email template" });
      const row = await CommunicationTemplate.findOne({ channel: "email", templateKey }).lean();
      return res.json({
        item,
        settings: emailSettingsFor(templateKey),
        revisions: (row?.revisions || []).slice().reverse(),
      });
    }

    return res.status(400).json({ message: "channel must be sms or email" });
  } catch (error) {
    console.error("Communication template read failed:", error);
    return res.status(500).json({ message: "Failed to load template" });
  }
});

/* -------------------------------------------------------------------------- */
/* Preview                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Render a candidate body against sample data.
 *
 * Accepts an unsaved body so the editor can show the true cost of an edit
 * before it is committed. Validation runs here too, so the segment count and
 * the errors arrive together rather than the admin discovering on Save that the
 * body they were happily previewing was never going to be accepted.
 */
router.post("/preview", auth, ...onlyAdmin, async (req, res) => {
  try {
    const channel = String(req.body?.channel || "sms");
    const templateKey = String(req.body?.templateKey || "");

    if (channel === "email") {
      const fn = EMAIL_TEMPLATES[templateKey];
      if (!fn) return res.status(404).json({ message: "Unknown email template" });

      const def = EMAIL_DEFINITIONS[templateKey];
      const candidateBody = typeof req.body?.body === "string" ? req.body.body : null;
      const candidateSubject = typeof req.body?.subject === "string" ? req.body.subject : null;

      /*
       * When the editor sends a candidate, render it exactly as a real send
       * would: the same token values, the same markup renderer, the same
       * branded frame. A preview that took a shortcut would be a preview of
       * something the customer is never going to receive.
       */
      if (def && candidateBody !== null) {
        const values = buildEmailTokens(templateKey, SAMPLE_EMAIL_VARS);
        const validation = validateEmailSave(templateKey, candidateSubject ?? "", candidateBody);
        const inner = emailMarkup.renderBody(candidateBody, values);
        const { frame, toText } = require("../utils/emailService");
        const html = frame(inner, { preheader: def.preheader || "" });
        return res.json({
          channel: "email",
          templateKey,
          subject: emailMarkup.renderSubject(candidateSubject ?? "", values),
          html,
          text: toText(html),
          validation: { valid: validation.valid, errors: validation.errors },
          variables: emailTokenNames(templateKey),
          protectedTokens: protectedTokensFor(templateKey),
          sent: false,
        });
      }

      const rendered = fn(SAMPLE_EMAIL_VARS);
      return res.json({
        channel: "email",
        templateKey,
        subject: String(rendered.subject || ""),
        html: String(rendered.html || ""),
        text: String(rendered.text || ""),
        validation: { valid: true, errors: [] },
        variables: def ? emailTokenNames(templateKey) : [],
        protectedTokens: protectedTokensFor(templateKey),
        sent: false,
      });
    }

    if (!SMS_TYPES[templateKey] || !DEFINITIONS[templateKey]) {
      return res.status(404).json({ message: "Unknown SMS type" });
    }

    const candidate =
      typeof req.body?.body === "string" ? req.body.body : DEFINITIONS[templateKey].template;
    const validation = validateTemplate(templateKey, candidate);
    const sample = SAMPLE_VARS[templateKey] || {};
    const rendered = renderTokenTemplate(candidate, buildTokenValues(templateKey, sample))
      .replace(/\s+/g, " ")
      .trim();

    return res.json({
      channel: "sms",
      templateKey,
      body: rendered,
      ...measure(rendered),
      validation,
      variables: tokensFor(templateKey, sample),
      sent: false,
    });
  } catch (error) {
    console.error("Communication preview failed:", error);
    return res.status(500).json({ message: "Failed to render preview" });
  }
});

/* -------------------------------------------------------------------------- */
/* Save and reset                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Everything that must be true before an admin's SMS body is accepted.
 *
 * REJECTS, NEVER REPAIRS. The renderer truncates at MAX_BODY_LENGTH, which is
 * correct for a template a developer wrote and tested, and wrong for a body
 * somebody typed thirty seconds ago: silently cutting it means the first person
 * to see the damage is a customer. So an over-length body is refused here with
 * the number, and the admin decides what to remove.
 */
function validateSmsSave(templateKey, body) {
  const validation = validateTemplate(templateKey, body);
  const errors = [...validation.errors];

  const sample = SAMPLE_VARS[templateKey] || {};
  const rendered = renderTokenTemplate(body, buildTokenValues(templateKey, sample))
    .replace(/\s+/g, " ")
    .trim();

  if (rendered.length > MAX_BODY_LENGTH) {
    errors.push(
      `Rendered message is ${rendered.length} characters, over the ${MAX_BODY_LENGTH} limit. ` +
        "Shorten it; it will not be truncated for you."
    );
  }

  /*
   * The review link, kept behind its flag.
   *
   * completionLinks already decides whether the review URL appears. A body that
   * types the URL directly would route around that decision, and the product
   * cannot yet tell who has already reviewed - so asking them again is exactly
   * the harm the flag exists to prevent.
   */
  if (/profixter\.com\/review/i.test(body)) {
    errors.push(
      "The review link cannot be written into a message body. It is supplied by the " +
        "{{completionLinks}} variable and is gated by SMS_REVIEW_LINK_ENABLED."
    );
  }

  return { valid: errors.length === 0, errors, rendered, measurement: measure(rendered) };
}

/**
 * Everything that must be true before an admin's email is accepted.
 *
 * The protected-token check is the one that matters. A password reset without
 * its code, or a gift invitation without its claim button, is an email that
 * looks fine in the editor and is useless to the person who receives it - and
 * nobody would notice until a customer could not reset their password. So a
 * body that drops a required token is refused, by name.
 */
function validateEmailSave(templateKey, subject, body) {
  const def = EMAIL_DEFINITIONS[templateKey];
  if (!def) return { valid: false, errors: ["This email template is not editable."] };

  const allowed = emailTokenNames(templateKey);
  const result = emailMarkup.validate({ subject, body, allowed });
  const errors = [...result.errors];

  for (const required of protectedTokensFor(templateKey)) {
    if (!result.usedTokens.includes(required)) {
      errors.push(
        `{{${required}}} must stay in the body. It carries this email's secure action, and the ` +
          "message does not work without it."
      );
    }
  }

  return { valid: errors.length === 0, errors, usedTokens: result.usedTokens };
}

router.put("/templates/email/:templateKey", auth, ...onlyAdmin, async (req, res) => {
  try {
    const templateKey = String(req.params.templateKey || "");
    if (!EMAIL_TEMPLATES[templateKey] || !EMAIL_DEFINITIONS[templateKey]) {
      return res.status(404).json({ message: "Unknown or non-editable email template" });
    }
    if (typeof req.body?.body !== "string" || typeof req.body?.subject !== "string") {
      return res.status(400).json({ message: "subject and body are required" });
    }

    const { subject, body } = req.body;
    const check = validateEmailSave(templateKey, subject, body);
    if (!check.valid) {
      return res.status(400).json({ message: "Template rejected", errors: check.errors });
    }

    const identity = adminIdentity(req);
    const existing = await CommunicationTemplate.findOne({ channel: "email", templateKey });

    if (existing) {
      existing.revisions.push({
        body: existing.body,
        subject: existing.subject,
        updatedAt: existing.updatedAt || new Date(),
        updatedBy: existing.updatedBy,
        updatedByName: existing.updatedByName,
      });
      existing.body = body;
      existing.subject = subject;
      existing.active = true;
      existing.updatedBy = identity.updatedBy;
      existing.updatedByName = identity.updatedByName;
      await existing.save();
    } else {
      await CommunicationTemplate.create({
        channel: "email",
        templateKey,
        subject,
        body,
        active: true,
        ...identity,
      });
    }

    overrides.invalidate();
    await overrides.refresh({ force: true });

    console.log(
      JSON.stringify({
        event: "communication_template_saved",
        channel: "email",
        templateKey,
        by: identity.updatedBy,
      })
    );

    return res.json({ templateKey, subject, body, hasOverride: true });
  } catch (error) {
    console.error("Email template save failed:", error);
    return res.status(500).json({ message: "Failed to save template" });
  }
});

router.post("/templates/email/:templateKey/reset", auth, ...onlyAdmin, async (req, res) => {
  try {
    const templateKey = String(req.params.templateKey || "");
    if (!EMAIL_TEMPLATES[templateKey]) {
      return res.status(404).json({ message: "Unknown email template" });
    }

    const identity = adminIdentity(req);
    const existing = await CommunicationTemplate.findOne({ channel: "email", templateKey });
    if (existing) {
      if (String(existing.body || "").trim()) {
        existing.revisions.push({
          body: existing.body,
          subject: existing.subject,
          updatedAt: existing.updatedAt || new Date(),
          updatedBy: existing.updatedBy,
          updatedByName: existing.updatedByName,
        });
      }
      existing.active = false;
      existing.body = "";
      existing.subject = "";
      existing.updatedBy = identity.updatedBy;
      existing.updatedByName = identity.updatedByName;
      await existing.save();
    }

    overrides.invalidate();
    await overrides.refresh({ force: true });

    console.log(
      JSON.stringify({
        event: "communication_template_reset",
        channel: "email",
        templateKey,
        by: identity.updatedBy,
      })
    );

    let codeSubject = "";
    try {
      codeSubject = String(EMAIL_TEMPLATES[templateKey](SAMPLE_EMAIL_VARS).subject || "");
    } catch {
      codeSubject = "";
    }
    return res.json({ templateKey, hasOverride: false, subject: codeSubject, body: "" });
  } catch (error) {
    console.error("Email template reset failed:", error);
    return res.status(500).json({ message: "Failed to reset template" });
  }
});

/**
 * Put a previous version back.
 *
 * Restoring is a save, not a rewind: the current wording is pushed onto the
 * revision stack first, so restoring the wrong one is itself undoable.
 */
router.post("/templates/:channel/:templateKey/restore/:index", auth, ...onlyAdmin, async (req, res) => {
  try {
    const { channel, templateKey } = req.params;
    if (channel !== "sms" && channel !== "email") {
      return res.status(400).json({ message: "channel must be sms or email" });
    }

    const row = await CommunicationTemplate.findOne({ channel, templateKey });
    if (!row) return res.status(404).json({ message: "No saved versions for this template" });

    const index = Number(req.params.index);
    const revision = row.revisions[index];
    if (!revision) return res.status(404).json({ message: "That version no longer exists" });

    const check =
      channel === "sms"
        ? validateSmsSave(templateKey, revision.body)
        : validateEmailSave(templateKey, revision.subject || "", revision.body);
    if (!check.valid) {
      return res.status(400).json({ message: "That version is no longer valid", errors: check.errors });
    }

    const identity = adminIdentity(req);
    row.revisions.push({
      body: row.body,
      subject: row.subject,
      updatedAt: row.updatedAt || new Date(),
      updatedBy: row.updatedBy,
      updatedByName: row.updatedByName,
    });
    row.body = revision.body;
    row.subject = revision.subject || "";
    row.active = true;
    row.updatedBy = identity.updatedBy;
    row.updatedByName = identity.updatedByName;
    await row.save();

    overrides.invalidate();
    await overrides.refresh({ force: true });

    return res.json({ templateKey, channel, body: row.body, subject: row.subject, hasOverride: true });
  } catch (error) {
    console.error("Template restore failed:", error);
    return res.status(500).json({ message: "Failed to restore version" });
  }
});

router.put("/templates/sms/:templateKey", auth, ...onlyAdmin, async (req, res) => {
  try {
    const templateKey = String(req.params.templateKey || "");
    if (!SMS_TYPES[templateKey] || !DEFINITIONS[templateKey]) {
      return res.status(404).json({ message: "Unknown SMS type" });
    }
    if (typeof req.body?.body !== "string") {
      return res.status(400).json({ message: "body is required" });
    }

    const body = req.body.body;
    const check = validateSmsSave(templateKey, body);
    if (!check.valid) {
      return res.status(400).json({ message: "Template rejected", errors: check.errors });
    }

    const identity = adminIdentity(req);
    const existing = await CommunicationTemplate.findOne({ channel: "sms", templateKey });

    if (existing) {
      /* Keep what it said before, so a bad edit is recoverable. */
      existing.revisions.push({
        body: existing.body,
        subject: existing.subject,
        updatedAt: existing.updatedAt || new Date(),
        updatedBy: existing.updatedBy,
        updatedByName: existing.updatedByName,
      });
      existing.body = body;
      existing.active = true;
      existing.updatedBy = identity.updatedBy;
      existing.updatedByName = identity.updatedByName;
      await existing.save();
    } else {
      await CommunicationTemplate.create({
        channel: "sms",
        templateKey,
        body,
        active: true,
        ...identity,
      });
    }

    /* This instance renders the new wording immediately; others within a minute. */
    overrides.invalidate();
    await overrides.refresh({ force: true });

    console.log(
      JSON.stringify({
        event: "communication_template_saved",
        channel: "sms",
        templateKey,
        by: identity.updatedBy,
      })
    );

    return res.json({
      templateKey,
      body,
      hasOverride: true,
      preview: { body: check.rendered, ...check.measurement },
    });
  } catch (error) {
    console.error("Communication template save failed:", error);
    return res.status(500).json({ message: "Failed to save template" });
  }
});

/**
 * Reset to default.
 *
 * Deactivates rather than deletes. The row keeps its revisions, so "what did we
 * change it to before somebody reset it?" stays answerable, and the code
 * template takes over on the very next render.
 */
router.post("/templates/sms/:templateKey/reset", auth, ...onlyAdmin, async (req, res) => {
  try {
    const templateKey = String(req.params.templateKey || "");
    if (!SMS_TYPES[templateKey]) return res.status(404).json({ message: "Unknown SMS type" });

    const identity = adminIdentity(req);
    const existing = await CommunicationTemplate.findOne({ channel: "sms", templateKey });
    if (existing) {
      if (String(existing.body || "").trim()) {
        existing.revisions.push({
          body: existing.body,
          subject: existing.subject,
          updatedAt: existing.updatedAt || new Date(),
          updatedBy: existing.updatedBy,
          updatedByName: existing.updatedByName,
        });
      }
      existing.active = false;
      existing.body = "";
      existing.updatedBy = identity.updatedBy;
      existing.updatedByName = identity.updatedByName;
      await existing.save();
    }

    overrides.invalidate();
    await overrides.refresh({ force: true });

    console.log(
      JSON.stringify({
        event: "communication_template_reset",
        channel: "sms",
        templateKey,
        by: identity.updatedBy,
      })
    );

    const sample = SAMPLE_VARS[templateKey] || {};
    const rendered = renderCodeDefault(templateKey, sample);
    return res.json({
      templateKey,
      hasOverride: false,
      body: DEFINITIONS[templateKey]?.template || "",
      preview: { body: rendered, ...measure(rendered) },
    });
  } catch (error) {
    console.error("Communication template reset failed:", error);
    return res.status(500).json({ message: "Failed to reset template" });
  }
});

/* -------------------------------------------------------------------------- */
/* History                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How an email row's real status is described.
 *
 * "sent" means the transport accepted it. It does NOT mean it arrived: there is
 * no bounce or delivery callback wired to this provider, so the schema has only
 * sent and failed and this must not invent a third. SMS can say delivered
 * because Twilio actually tells us; email cannot, and pretending otherwise
 * would make the one honest signal we do have worthless.
 */
function emailRowToRecord(row) {
  return {
    id: String(row._id),
    channel: "email",
    at: row.createdAt,
    type: row.templateKey || row.emailType || "email",
    status: row.status,
    statusDetail:
      row.status === "sent"
        ? "Accepted by the mail provider. Delivery to the inbox is not confirmed."
        : row.errorMessage || "Send failed.",
    destination: row.recipientEmail || row.customerEmail || "",
    bookingNumber: row.bookingNumber || "",
    providerMessageId: row.providerMessageId || "",
    subject: row.subject || "",
    body: row.bodySnapshot ? row.html || row.text || "" : "",
    bodyIsHtml: Boolean(row.bodySnapshot && row.html),
    hasSnapshot: Boolean(row.bodySnapshot),
    snapshotNote: row.bodySnapshot
      ? ""
      : "Content snapshot unavailable for emails sent before communication history snapshots were enabled.",
    failureReason: row.errorMessage || "",
    errorCode: row.errorCode || "",
  };
}

/**
 * How an SMS row's real status is described.
 *
 * delivered appears only when Twilio's delivered callback set it. A message
 * Twilio merely accepted stays "sent", because the gap between the two is
 * exactly where carrier filtering hides.
 */
function smsRowToRecord(row) {
  const detail = {
    simulated: "Rendered and recorded, but not sent: SMS sending is disabled.",
    suppressed: `Not sent: ${row.suppressionReason || "suppressed"}.`,
    pending: "Queued, not yet handed to Twilio.",
    sending: "In flight.",
    sent: "Accepted by Twilio. Handset delivery not yet confirmed.",
    delivered: "Confirmed delivered by the carrier.",
    undelivered: `Carrier rejected it${row.providerErrorCode ? ` (${row.providerErrorCode})` : ""}.`,
    failed: `Failed${row.providerErrorCode ? ` (${row.providerErrorCode})` : ""}: ${
      row.suppressionReason || row.providerErrorMessage || "unknown"
    }.`,
    retry_scheduled: "Transient failure; a retry is scheduled.",
  };

  return {
    id: String(row._id),
    channel: "sms",
    at: row.createdAt,
    type: row.notificationType,
    status: row.status,
    statusDetail: detail[row.status] || row.status,
    destination: maskPhone(row.toPhone),
    bookingNumber: row.bookingNumber || "",
    providerMessageId: row.providerMessageSid || "",
    subject: "",
    body: row.body || "",
    bodyIsHtml: false,
    hasSnapshot: Boolean(row.body),
    snapshotNote: "",
    failureReason: row.suppressionReason || row.providerErrorMessage || "",
    errorCode: row.providerErrorCode || "",
    channelClass: row.channelClass,
    segments: row.segments || 0,
    deliveredAt: row.deliveredAt || null,
  };
}

function byNewest(a, b) {
  return new Date(b.at).getTime() - new Date(a.at).getTime();
}

/**
 * Everything ProFixter has said to one customer, both channels, newest first.
 *
 * Email is matched on the addresses recorded on the account and SMS on the
 * user reference, because the two collections were built at different times
 * and key their recipient differently. Matching each the way it actually
 * stores its recipient is what stops this quietly returning half the history.
 */
router.get("/customers/:userId/history", auth, ...onlyAdmin, async (req, res) => {
  try {
    const rawId = String(req.params.userId || "");
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100)));
    const objectId = mongoose.Types.ObjectId.isValid(rawId) ? new mongoose.Types.ObjectId(rawId) : null;

    const user = objectId ? await User.findById(objectId).select("email userId phone name").lean() : null;
    const emails = [user?.email].filter(Boolean).map((e) => String(e).toLowerCase());

    const smsMatch = objectId ? { $or: [{ user: objectId }, { userId: rawId }] } : { userId: rawId };
    const emailMatch = emails.length
      ? { $or: [{ recipientEmail: { $in: emails } }, { customerEmail: { $in: emails } }] }
      : { userId: rawId };

    const [smsRows, emailRows] = await Promise.all([
      SmsMessage.find(smsMatch).sort({ createdAt: -1 }).limit(limit).lean(),
      EmailLog.find(emailMatch).sort({ createdAt: -1 }).limit(limit).lean(),
    ]);

    const records = [...smsRows.map(smsRowToRecord), ...emailRows.map(emailRowToRecord)].sort(byNewest);

    return res.json({
      customer: user ? { id: String(user._id), name: user.name, email: user.email } : null,
      records: records.slice(0, limit),
      counts: { sms: smsRows.length, email: emailRows.length },
    });
  } catch (error) {
    console.error("Customer communication history failed:", error);
    return res.status(500).json({ message: "Failed to load communication history" });
  }
});

/**
 * Everything said about one booking.
 *
 * Scoped by booking number rather than by customer on purpose: the question
 * this answers is "did the confirmation and the reminders for THIS visit go
 * out", and folding in the customer's password resets and membership notices
 * would bury the answer.
 */
router.get("/bookings/:bookingNumber/history", auth, ...onlyAdmin, async (req, res) => {
  try {
    const bookingNumber = String(req.params.bookingNumber || "").trim();
    if (!bookingNumber) return res.status(400).json({ message: "bookingNumber is required" });

    const [smsRows, emailRows] = await Promise.all([
      SmsMessage.find({ bookingNumber }).sort({ createdAt: -1 }).limit(200).lean(),
      EmailLog.find({ bookingNumber }).sort({ createdAt: -1 }).limit(200).lean(),
    ]);

    const records = [...smsRows.map(smsRowToRecord), ...emailRows.map(emailRowToRecord)].sort(byNewest);
    return res.json({ bookingNumber, records, counts: { sms: smsRows.length, email: emailRows.length } });
  } catch (error) {
    console.error("Booking communication history failed:", error);
    return res.status(500).json({ message: "Failed to load booking communications" });
  }
});

module.exports = router;
module.exports.emailRowToRecord = emailRowToRecord;
module.exports.smsRowToRecord = smsRowToRecord;
module.exports.validateSmsSave = validateSmsSave;
module.exports.measure = measure;
