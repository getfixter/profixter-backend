/**
 * CI test runner — invoked by `npm test` from .github/workflows/deploy-eb.yml.
 *
 * Runs only suites that are deterministic and need NO database, network, AWS
 * or Stripe access, so a deploy is never blocked by an environment problem.
 * Suites that require a live MongoDB are deliberately excluded and are run
 * locally against a disposable database instead.
 *
 *   npm test
 */

const { spawnSync } = require("child_process");
const path = require("path");

/** Deterministic, dependency-free suites. */
const SUITES = [
  // First: nothing below is worth running if the app cannot even be loaded.
  "test_module_load.js",
  "test_service_area.js",
  "test_signup_address.js",
  "test_change_order_totals.js",
  "test_project_financials.js",
  "test_document_dates.js",
  "test_png_ink_box.js",
  "test_invoice_online_payments.js",
  "test_invoice_payment_notification.js",
  "test_fixter_tips.js",
  "test_change_order_document.js",
  "test_esign_signature_flow.js",
  "test_native_signing.js",
  "test_executed_document.js",
  "test_intro_visit_eligibility.js",
  "test_one_time_booking_policy.js",
  "test_member_visit_lead_time.js",
  "test_member_calendar_availability.js",
  "test_one_time_visit_payment_flow.js",
  // Review fix 1: the payment-received email prints "$99", not "99".
  "test_one_time_payment_email_price.js",
  "test_customer_booking_cutover.js",
  "test_booking_cutover_routes.js",
  "test_slot_reservation_service.js",
  "test_booking_slot_reservation_model.js",
  "test_explicit_appointment_starts.js",
  "test_visit_entitlement_indexes.js",
  "test_full_day_visit.js",
  "test_meta_tracking.js",
  // Webhook conversions: charged value, staff sales unreported, gift Purchase, browser ids.
  "test_meta_conversions.js",
  // The homepage one-step free-visit request (in-memory Mongo): consent, Lead dedup, notifications.
  "test_free_visit_request.js",
  // Guest requests reserve slots, Admin confirms, one lifetime free visit (in-memory replica set).
  "test_free_visit_reservations_integration.js",
  "test_admin_overview.js",
  "test_admin_overview_finance.js",
  "test_meta_ad_spend.js",
  "test_visibility.js",
  // Trust ladder, idempotency and consent re-checks of the growth engine (in-memory Mongo, like the Overview suites).
  "test_growth_engine_integration.js",
  "test_meta_campaign_audit.js",
  "test_agents_integration.js",
  // Meta advertising is read-only, permanently (agency-managed).
  "test_meta_read_only.js",
  "test_playbooks_integration.js",
  "test_seo_actions_integration.js",
  "test_conversations_integration.js",
  "test_outreach_integration.js",
  "test_growth_office_integration.js",
  "test_council_integration.js",
  "test_member_reconcile.js",
  "test_marketing_data.js",
  "test_decision_board.js",
  "test_attention.js",
  "test_kingdom_accountability.js",
  "test_kingdom_nov3.js",
  "test_acquisition_scope.js",
  "test_organic_autonomy.js",
  "test_office_explain_integration.js",
  "test_admin_access.js",
  "test_client_ip.js",
  "test_chatbot_lead_rules.js",
  "test_chatbot_answer.js",
  // Admin edits a customer: owner-only phone/email, verification reset, audit (in-memory Mongo).
  "test_admin_customer_edit.js",
  "test_attribution.js",
  "test_transactional_email_system.js",
  "test_admin_customer_calendar_integration.js",
  "test_customer_availability_readiness.js",
  "test_calendar_deployment_gate.js",
  "test_booking_content_updates.js",
  "test_booking_photo_sanitizer.js",
  "test_document_storage_privacy.js",
  "test_checkout_return_urls.js",
  "test_membership_map.js",
  "test_recent_work.js",
  "test_event_display.js",
  "test_booking_library.js",
  "test_marketing_system.js",
  "test_free_visit_lifecycle.js",
  "test_marketing_longterm.js",
  "test_unsubscribe_token.js",
  "test_membership_coupon_details.js",
  "test_membership_annual_pricing.js",
  "test_subscription_cancellation_admin_email.js",
  "test_billing_portal_configuration.js",
  "test_sms_core.js",
  "test_sms_marketing_preference.js",
  "test_consent_system.js",
  "test_marcus_followups.js",
  "test_sms_consent_mechanics.js",
  // Pending is never "confirmed"; the Free Visit email and follow-ups promise no labor.
  "test_notification_accuracy.js",
  "test_legacy_consent_migration.js",
  "test_sms_inbound_safety.js",
  "test_marketing_launch_gate.js",
  "test_ghl_separation.js",
  "test_a2p_public_evidence.js",
  "test_admin_communications.js",
  "test_admin_email_templates.js",
  "test_loyalty_rules.js",
  "test_gift_membership.js",
  "test_gift_membership_tax.js",
  "test_gift_digital_experience.js",
  // New-customer welcome offer: 20% off the first monthly invoice, ten minutes, Stripe faked (in-memory Mongo).
  "test_welcome_offer.js",
  // Halloween 2026 campaign sender: consent per channel, members excluded, once only (in-memory Mongo, SMS simulated).
  "test_halloween_campaign.js",
  "test_admin_marketing_consent.js",
  // Post-visit review requests: the 60-minute delay, one per booking, the per-customer cooldown, locks.
  "test_booking_review_requests.js",
  // Jobs allow-list, labels, record scope and Admin email links (no database).
  "test_booking_transitions.js",
  // Jobs API: Fixter record scope, atomic transitions, edits, reschedule, cancel, Needs action (in-memory replica set).
  "test_admin_jobs_integration.js",
  // Admin redesign (BE-CUST): confirmed plan changes, cancellation, complimentary, legacy refusals, no N+1 (in-memory Mongo, Stripe faked).
  "test_admin_customer_membership.js",
  // Block enforced at every booking/request/checkout entry point by account, email and phone; unblock keeps history.
  "test_customer_block_enforcement.js",
  // Customer list/search/profile, lean DTOs, billing proxy (Stripe faked), notes, archive, consent, comms history.
  "test_admin_customer_directory.js",
  // Admin redesign (BE-DOCS), 2026-11-12.
  // Revocable sessions: logout, logout-all, legacy-token denylist (in-memory Mongo).
  "test_sessions_logout.js",
  // 2 MB body limit, public lead rate limits, no public ping, generic 5xx.
  "test_server_hardening.js",
  // Local Admin preview stack: live-looking env refused, outbound network blocked, fakes in place (no DB, no network).
  "preview/test_preview_safety.js",
  // Queued campaign send: snapshot, lease, resume never resends (in-memory Mongo, SES faked).
  "test_campaign_send_queue.js",
  // GoHighLevel retired: no Google posting, no GHL replies (in-memory Mongo).
  "test_ghl_retirement.js",
  // Nothing promotes itself from supervised to autonomous; honest office texts.
  "test_no_promote_after.js",
  // Void/cancel/supersede beat a live signing link; signed copies write-once; invoice void with payments refused.
  "test_document_integrity.js",
  // Lead -> project, next steps, overview, deposit/milestone billing once, closeout, needs-action collectors.
  "test_project_workflow.js",
  // Document sends: idempotencyKey replay, 60s duplicate guard, raw signing link never stored.
  "test_document_send_idempotency.js",
  // Log searches in POST bodies (email, SMS, opt-outs, phone status, activity) and the campaign list.
  "test_admin_log_search.js",
  // Project suites that existed but were never registered.
  "test_premium_island_contracts.js",
  "test_premium_island_invoices.js",
  "test_project_soft_delete.js",
  "test_project_customer_selection.js",
  // Old invoice email links find their project (ids only, projects.manage).
  "test_invoice_locate.js",
];

/**
 * Suites intentionally NOT run in CI, and why:
 *   test_loyalty_integration.js     boots an in-memory MongoDB binary
 *   test_auth_v2_integration.js     boots an in-memory MongoDB binary
 *   test_signup_to_booking_journey.js  boots an in-memory MongoDB replica set
 *   test_user_email_index_migration.js boots an in-memory MongoDB binary
 *   check_auth_providers.js          provider readiness check, needs real credentials
 *   test_admin_loyalty_integration.js  boots an in-memory MongoDB binary
 *   test_intro_visit_flows_live.js   needs a live MongoDB
 *   test_booking_reminders_integration.js  boots an in-memory MongoDB binary
 *   test_marketing_engine_integration.js   boots an in-memory MongoDB binary
 *   test_general_fixter_notifications.js   boots an in-memory MongoDB binary
 *   test_intro_visit_race_live.js    needs a live MongoDB + running backend
 *   test_intro_visit_photo_live.js   needs a live MongoDB + running backend + S3 stub
 *   test_native_signing_integration.js  boots an in-memory MongoDB binary
 *   test_native_signing_routes.js       boots an in-memory MongoDB binary
 *   test_fixter_tips_integration.js     boots an in-memory MongoDB binary
 *   test_membership_duplicate_sync.js   boots an in-memory MongoDB binary
 *   test_dual_account_users.js          boots an in-memory MongoDB binary
 *   test_membership_lead.js             boots an in-memory MongoDB binary
 *   test_sms_integration.js             boots an in-memory MongoDB binary
 *   test_gift_membership_integration.js boots an in-memory MongoDB binary
 *   test_admin_gift_checkout.js         boots an in-memory MongoDB binary
 *   test_project_financials_integration.js  boots an in-memory MongoDB binary
 *   test_full_day_capacity_integration.js   boots an in-memory MongoDB binary
 *   test_visibility_integration.js          boots an in-memory MongoDB binary
 *   test_admin_tools_integration.js         boots an in-memory MongoDB replica set
 *   test_cx4_integration.js                 boots an in-memory MongoDB replica set
 *   test_cx5_integration.js                 boots an in-memory MongoDB binary
 *   test_membership_first_visit.js          boots an in-memory MongoDB replica set
 *   seed_intro_visit_testdata.js     writes synthetic data, local only
 *   local_s3_stub.js                 local test helper, not a test
 */

const failed = [];

for (const suite of SUITES) {
  const file = path.join(__dirname, suite);
  process.stdout.write(`${suite.padEnd(46)}`);
  const result = spawnSync(process.execPath, [file], {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test" },
  });

  if (result.status === 0) {
    console.log("PASS");
  } else {
    console.log("FAIL");
    failed.push({ suite, out: result.stdout?.toString() || "", err: result.stderr?.toString() || "" });
  }
}

if (failed.length) {
  console.error(`\n${failed.length} suite(s) failed:\n`);
  for (const f of failed) {
    console.error(`--- ${f.suite} ---`);
    console.error(f.out.split("\n").slice(-25).join("\n"));
    console.error(f.err.split("\n").slice(-25).join("\n"));
  }
  process.exit(1);
}

console.log(`\n${SUITES.length} suites passed.`);
process.exit(0);
