/**
 * Every email key this application can write to EmailLog, and what we do about it.
 *
 * THE RULE THIS FILE ENFORCES: NO MYSTERY EMAIL.
 *
 * Before Phase 2 the Communications screen showed the 34 templates that go
 * through sendTx and silently omitted everything sent through sendRaw or
 * sendPromo - roughly twenty more keys, including contracts, invoices,
 * signature requests and every internal alert. An admin looking at
 * Communications would have concluded those did not exist.
 *
 * So every key is listed here with a disposition, and a test asserts that any
 * key appearing in a templateKey literal anywhere in the codebase has an entry.
 * Adding a new email without classifying it fails CI, which is the only way a
 * list like this stays true.
 *
 * THE THREE DISPOSITIONS
 *
 *   editable    Registered through sendTx with a token form. Admin controls the
 *               subject and body; the branded frame stays system-managed.
 *
 *   visible     Listed, described and previewable where possible, but the body
 *               is assembled at the call site rather than from a template - an
 *               internal alert built from a booking, a campaign whose copy the
 *               admin already wrote elsewhere. Making these editable would mean
 *               moving call-site logic into the database for no benefit.
 *
 *   generated   The body IS a generated document: a contract, an invoice, a
 *               change order, an executed signature packet. The content is
 *               legally or financially load-bearing and is produced from
 *               project data. Letting anybody retype it in an admin form would
 *               be the single most dangerous edit box in the product, so these
 *               are shown and explained and their content is never editable.
 */

const DISPOSITIONS = { EDITABLE: "editable", VISIBLE: "visible", GENERATED: "generated" };

/**
 * Keys that do NOT go through the sendTx registry.
 *
 * `category` mirrors the A/B/C classification: A customer-facing system mail,
 * B internal or operational, C generated document delivery.
 */
const NON_REGISTRY_EMAILS = {
  /* ---------------- A: customer-facing, security-critical ---------------- */
  native_signature_request: {
    label: "Signature request",
    category: "A",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Customer",
    channelClass: "transactional",
    trigger: "An admin sends a contract, estimate or change order for e-signature.",
    source: "utils/esign/signingEmails.js",
    protectedNote:
      "Carries a single-use signing link bound to one document and signer. The link and the " +
      "document summary are built at the call site from the signing record.",
  },
  native_signature_reminder: {
    label: "Signature reminder",
    category: "A",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Customer",
    channelClass: "transactional",
    trigger: "An admin re-sends an unsigned document.",
    source: "utils/esign/signingEmails.js",
    protectedNote: "Same single-use signing link as the original request.",
  },
  native_signature_completed: {
    label: "Signed document delivery",
    category: "C",
    disposition: DISPOSITIONS.GENERATED,
    audience: "Customer and internal",
    channelClass: "transactional",
    trigger: "All parties finish signing.",
    source: "utils/esign/signingEmails.js",
    protectedNote:
      "Delivers the executed document. The body reflects a completed legal signing ceremony, " +
      "including signer identities and timestamps, and must not be rewritable after the fact.",
  },

  /* -------------------- C: generated business documents ------------------ */
  premium_island_contract: {
    label: "Contract delivery",
    category: "C",
    disposition: DISPOSITIONS.GENERATED,
    audience: "Customer",
    channelClass: "transactional",
    trigger: "An admin issues a Premium Island Homes contract.",
    source: "routes/adminContracts.js",
    protectedNote: "Body is the generated contract with its terms. Editable copy would change a legal document.",
  },
  premium_island_change_order: {
    label: "Change order delivery",
    category: "C",
    disposition: DISPOSITIONS.GENERATED,
    audience: "Customer",
    channelClass: "transactional",
    trigger: "An admin issues a change order.",
    source: "routes/adminChangeOrders.js",
    protectedNote: "Body is the generated change order, including scope and price deltas.",
  },
  premium_island_invoice: {
    label: "Invoice delivery",
    category: "C",
    disposition: DISPOSITIONS.GENERATED,
    audience: "Customer",
    channelClass: "transactional",
    trigger: "An admin sends an unpaid invoice.",
    source: "routes/adminInvoices.js",
    protectedNote: "Body is the generated invoice with line items and amounts due.",
  },
  premium_island_paid_invoice: {
    label: "Paid invoice receipt",
    category: "C",
    disposition: DISPOSITIONS.GENERATED,
    audience: "Customer",
    channelClass: "transactional",
    trigger: "An invoice is marked Paid in Full.",
    source: "routes/adminInvoices.js",
    protectedNote: "Body is the generated receipt. It is a financial record.",
  },

  /* --------------------- B: internal and operational --------------------- */
  admin_lead_notification: {
    label: "Admin: new lead",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Internal",
    channelClass: "internal",
    trigger: "A lead or estimate request arrives.",
    source: "utils/adminLeadNotification.js",
  },
  admin_event_notification: {
    label: "Admin: generic event",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Internal",
    channelClass: "internal",
    trigger: "Fallback alert when a caller supplies no more specific key.",
    source: "utils/adminLeadNotification.js",
  },
  admin_booking_created: {
    label: "Admin: booking created",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Internal",
    channelClass: "internal",
    trigger: "A customer books a visit.",
    source: "routes/bookings.js",
  },
  admin_membership_lead: {
    label: "Admin: membership lead",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Internal",
    channelClass: "internal",
    trigger: "A membership callback request is submitted.",
    source: "utils/adminLeadNotification.js",
  },
  admin_one_time_visit_paid: {
    label: "Admin: One-Time Visit paid",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Internal",
    channelClass: "internal",
    trigger: "A One-Time Visit payment succeeds.",
    source: "routes/webhook.js",
  },
  admin_full_day_visit_paid: {
    label: "Admin: Full Day paid",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Internal",
    channelClass: "internal",
    trigger: "A Full Day Service payment succeeds.",
    source: "routes/webhook.js",
  },
  admin_subscription_started: {
    label: "Admin: membership started",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Internal",
    channelClass: "internal",
    trigger: "A membership becomes active.",
    source: "routes/webhook.js",
  },
  admin_subscription_canceled: {
    label: "Admin: membership cancelled",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Internal",
    channelClass: "internal",
    trigger: "A membership is cancelled.",
    source: "routes/subscriptions.js",
  },
  admin_retention_offer_accepted: {
    label: "Admin: retention offer accepted",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Internal",
    channelClass: "internal",
    trigger: "A member accepts a retention offer instead of cancelling.",
    source: "routes/subscriptions.js",
  },
  admin_invoice_paid_online: {
    label: "Admin: invoice paid online",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Internal",
    channelClass: "internal",
    trigger: "A customer pays an invoice online.",
    source: "utils/invoicePaymentNotification.js",
  },
  general_fixter_booking_created: {
    label: "Partner: booking created",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Partner / general Fixter",
    channelClass: "internal",
    trigger: "A booking is routed to a general Fixter partner.",
    source: "utils/generalFixterNotify.js",
  },
  general_fixter_booking_canceled: {
    label: "Partner: booking cancelled",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Partner / general Fixter",
    channelClass: "internal",
    trigger: "A routed booking is cancelled.",
    source: "utils/generalFixterNotify.js",
  },

  /* ----------------------- Admin-authored marketing ---------------------- */
  campaign: {
    label: "Marketing campaign send",
    category: "A",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Customer",
    channelClass: "marketing",
    trigger: "An admin runs an email campaign.",
    source: "routes/adminCampaigns.js",
    protectedNote:
      "The body IS the campaign the admin already composed in the campaign editor. A second " +
      "template layer here would be two places to edit the same words.",
  },
  campaign_test: {
    label: "Marketing campaign test send",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Internal",
    channelClass: "marketing",
    trigger: "An admin previews a campaign by sending it to the admin address.",
    source: "routes/adminCampaigns.js",
  },
  campaign_admin_copy: {
    label: "Marketing campaign admin copy",
    category: "B",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Internal",
    channelClass: "marketing",
    trigger: "A campaign run copies the admin address.",
    source: "routes/adminCampaigns.js",
  },
  promo: {
    label: "Promotional send (generic)",
    category: "A",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Customer",
    channelClass: "marketing",
    trigger: "Generic promotional transport used by campaign and nurture paths.",
    source: "utils/emailService.js sendPromo",
    protectedNote: "A transport, not a template: the caller supplies the subject and body.",
  },
  promo_markdown: {
    label: "Promotional send (markdown)",
    category: "A",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Customer",
    channelClass: "marketing",
    trigger: "Promotional transport that renders markdown supplied by the caller.",
    source: "utils/emailService.js sendPromoMarkdown",
    protectedNote: "A transport, not a template.",
  },
  "marketing:*": {
    label: "Marketing engine send",
    category: "A",
    disposition: DISPOSITIONS.VISIBLE,
    audience: "Customer",
    channelClass: "marketing",
    trigger: "The marketing engine sends one of its own configured templates.",
    source: "utils/marketing/marketingRunner.js",
    dynamic: true,
    protectedNote:
      "Key is marketing:<template id>. Copy lives in the marketing engine's own template " +
      "configuration, which already has an editor.",
  },
};

/** True when a logged key belongs to a dynamic family rather than a literal. */
function dynamicFamilyFor(key) {
  if (String(key || "").startsWith("marketing:")) return "marketing:*";
  return null;
}

function nonRegistryEntry(key) {
  return NON_REGISTRY_EMAILS[key] || NON_REGISTRY_EMAILS[dynamicFamilyFor(key)] || null;
}

module.exports = { DISPOSITIONS, NON_REGISTRY_EMAILS, dynamicFamilyFor, nonRegistryEntry };
