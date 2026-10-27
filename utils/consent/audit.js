const User = require("../../models/User");
const Subscription = require("../../models/Subscription");
const SmsOptOut = require("../../models/SmsOptOut");
const EmailSuppression = require("../../models/EmailSuppression");
const { subscriptionGrantsAccess } = require("../subscriptionManagement");
const { toE164 } = require("../sms/smsPhone");
const { consentStatus } = require("./status");

/**
 * THE CONSENT AUDIT: every registered customer, what they may be sent, and
 * anything in the records that looks wrong. READ-ONLY and COUNTS ONLY - it
 * changes nothing, contacts nobody, and its output carries no name, email or
 * phone, so it can be logged and read from the server log.
 *
 * "Registered customer" = a customer account (role customer, or no role -
 * most of the base predates the field), staff never. Membership is read the
 * way marketing reads it: a subscription that grants access today = member,
 * any earlier one = former member, none = non-member.
 */
const bump = (o, k) => {
  o[k] = (o[k] || 0) + 1;
};

async function consentAudit({ now = new Date() } = {}) {
  const users = await User.find({
    $or: [{ role: "customer" }, { role: { $exists: false } }, { role: null }, { role: "" }],
    employeePosition: { $in: [null, ""] },
  })
    .select("_id email phone role isActive employeePosition excludeFromMarketing smsPreferences emailPreferences legacyRegisteredUser")
    .lean();

  const [subs, optOuts, suppressions] = await Promise.all([
    Subscription.find({ user: { $in: users.map((u) => u._id) } }).lean(),
    SmsOptOut.find({}).lean(),
    EmailSuppression.find({}).lean(),
  ]);
  const subsByUser = new Map();
  for (const s of subs) {
    const k = String(s.user);
    if (!subsByUser.has(k)) subsByUser.set(k, []);
    subsByUser.get(k).push(s);
  }
  const optOutByPhone = new Map(optOuts.map((o) => [o.phone, o]));
  const suppressionByEmail = new Map(suppressions.map((s) => [String(s.email).toLowerCase(), s]));

  const out = {
    registeredCustomers: users.length,
    byMembership: { non_member: 0, member: 0, former_member: 0 },
    email: {},
    smsMarketing: {},
    smsService: {},
    // per membership group, the channels that matter for follow-ups
    nonMembers: { email: {}, smsMarketing: {} },
    // things in the records worth a human look (counts only)
    checks: {
      smsMarketingOnWithoutEvidence: 0,
      smsServiceOnWithoutEvidence: 0,
      startedAfterStopButTextsStillOff: 0,
      emailSuppressedByBounceOrComplaint: 0,
      phonesSharedByAccounts: 0,
      legacyNeverAsked: 0,
    },
  };

  const phoneCount = new Map();
  for (const u of users) {
    const list = subsByUser.get(String(u._id)) || [];
    const audience = list.some((s) => subscriptionGrantsAccess(s, { now })) ? "member" : list.length ? "former_member" : "non_member";
    out.byMembership[audience] += 1;

    const e164 = toE164(u.phone);
    if (e164) phoneCount.set(e164, (phoneCount.get(e164) || 0) + 1);
    const optOut = e164 ? optOutByPhone.get(e164) || null : null;
    const suppression = suppressionByEmail.get(String(u.email || "").trim().toLowerCase()) || null;
    const st = consentStatus(u, { suppression, optOut });
    bump(out.email, st.email);
    bump(out.smsMarketing, st.smsMarketing);
    bump(out.smsService, st.smsService);
    if (audience === "non_member") {
      bump(out.nonMembers.email, st.email);
      bump(out.nonMembers.smsMarketing, st.smsMarketing);
    }

    const p = u.smsPreferences || {};
    if (p.marketingEnabled === true && !p.marketingConsentAt) out.checks.smsMarketingOnWithoutEvidence += 1;
    if (p.transactionalEnabled === true && !p.transactionalConsentAt) out.checks.smsServiceOnWithoutEvidence += 1;
    if (optOut?.optedInAt && new Date(optOut.optedInAt) >= new Date(optOut.optedOutAt) && p.optOutSource === "" && p.marketingEnabled === false && p.transactionalEnabled === false) {
      out.checks.startedAfterStopButTextsStillOff += 1;
    }
    if (st.email === "blocked") out.checks.emailSuppressedByBounceOrComplaint += 1;
    if (u.legacyRegisteredUser === true && p.marketingEnabled === undefined) out.checks.legacyNeverAsked += 1;
  }
  out.checks.phonesSharedByAccounts = [...phoneCount.values()].filter((n) => n > 1).length;

  /* The headline the owner asked for. */
  const n = (o, k) => o[k] || 0;
  out.summary = {
    registeredCustomers: users.length,
    emailMarketing: {
      explicitOptIn: n(out.email, "opted_in"),
      existingCustomerNotUnsubscribed: n(out.email, "existing_customer"),
      unsubscribed: n(out.email, "unsubscribed"),
      blocked: n(out.email, "blocked"),
      notMarketable: n(out.email, "not_marketable"),
    },
    smsMarketing: {
      verifiedOptIn: n(out.smsMarketing, "opted_in"),
      optedOut: n(out.smsMarketing, "opted_out"),
      stopped: n(out.smsMarketing, "stopped"),
      unknownNeverAsked: n(out.smsMarketing, "unknown"),
      noPhoneOrExcluded: n(out.smsMarketing, "no_phone") + n(out.smsMarketing, "excluded"),
    },
  };
  return out;
}

module.exports = { consentAudit };
