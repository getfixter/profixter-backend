const express = require("express");

const router = express.Router();

/*
 * GoHighLevel, legacy routes.
 *
 * POST /api/ghl/lead-assigned (RETIRED 2026-11, 410 Gone). It created
 * RepAttribution rows that the Stripe webhook later matched to customers by
 * phone or EMAIL, crediting 50% of the catalog price (Annual Basic: $745) and
 * overwriting amounts even after they were marked paid. Sales credit now comes
 * only from verified first payments and explicit assignments (utils/sales).
 * The historical rows are kept read-only; scripts/ops/legacy_rep_attribution_report.js
 * reports on them. A call here writes nothing.
 *
 * POST /api/ghl/inbound-message was REMOVED on 2026-11-12 (owner decision
 * Q-6): it fed homeowner messages to the retired GoHighLevel reply agent.
 *
 * The current, deliberate GHL sync is POST /api/ghl/webhook (signed, off by
 * default), mounted with a raw body in server.js: utils/sales/ghl.js.
 */
router.post("/lead-assigned", (_req, res) =>
  res.status(410).json({ code: "RETIRED", message: "This webhook is retired. Assign leads in the Profixter sales desk." })
);

module.exports = router;
