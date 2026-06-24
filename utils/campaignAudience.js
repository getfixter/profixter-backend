const User = require("../models/User");
const Subscription = require("../models/Subscription");
const Blacklist = require("../models/Blacklist");
const EmailSuppression = require("../models/EmailSuppression");
const { subscriptionGrantsAccess } = require("./subscriptionManagement");

const SEGMENTS = Object.freeze([
  "all",
  "subscribed",
  "not_subscribed",
  "basic",
  "plus",
  "premium",
  "elite",
]);
const PLAN_SEGMENTS = new Set(["basic", "plus", "premium", "elite"]);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeSegment(value) {
  const segment = String(value || "").trim().toLowerCase();
  if (!SEGMENTS.includes(segment)) {
    const error = new Error("Invalid email audience segment");
    error.statusCode = 400;
    throw error;
  }
  return segment;
}

function userMatchesSegment(recipient, segment) {
  if (segment === "all") return true;
  if (segment === "subscribed") return recipient.plans.length > 0;
  if (segment === "not_subscribed") return recipient.plans.length === 0;
  return recipient.plans.includes(segment);
}

function isCustomerLike(user) {
  const role = String(user?.role || "").trim().toLowerCase();
  return !role || role === "customer";
}

function buildEligibleRecipients({
  users,
  subscriptions,
  blacklist = [],
  suppressions = [],
  adminEmail,
}) {
  const blockedUserIds = new Set(
    blacklist.map((entry) => String(entry.user || "")).filter(Boolean)
  );
  const blockedEmails = new Set(
    blacklist.map((entry) => normalizeEmail(entry.email)).filter(Boolean)
  );
  const suppressedEmails = new Set(
    suppressions.map((entry) => normalizeEmail(entry.email)).filter(Boolean)
  );

  const eligibleUsers = [];
  const seenEmails = new Set();
  for (const user of users) {
    const email = normalizeEmail(user.email);
    if (
      !isCustomerLike(user) ||
      user.isActive === false ||
      !EMAIL_RE.test(email) ||
      email === normalizeEmail(adminEmail) ||
      blockedUserIds.has(String(user._id)) ||
      blockedEmails.has(email) ||
      suppressedEmails.has(email) ||
      seenEmails.has(email)
    ) {
      continue;
    }
    seenEmails.add(email);
    eligibleUsers.push({ ...user, email });
  }

  const plansByUser = new Map();
  const statusesByUser = new Map();
  const activeSubscriptionsByUser = new Map();
  for (const subscription of subscriptions) {
    if (!subscriptionGrantsAccess(subscription)) continue;
    const plan = String(subscription.subscriptionType || "").toLowerCase();
    if (!PLAN_SEGMENTS.has(plan)) continue;
    const userId = String(subscription.user);
    if (!plansByUser.has(userId)) plansByUser.set(userId, new Set());
    plansByUser.get(userId).add(plan);
    if (!statusesByUser.has(userId)) statusesByUser.set(userId, new Set());
    statusesByUser.get(userId).add(String(subscription.status || ""));
    if (!activeSubscriptionsByUser.has(userId)) activeSubscriptionsByUser.set(userId, []);
    activeSubscriptionsByUser.get(userId).push(subscription);
  }

  return eligibleUsers.map((user) => {
    const plans = Array.from(plansByUser.get(String(user._id)) || []).sort();
    const subscriptionStatuses = Array.from(
      statusesByUser.get(String(user._id)) || []
    ).sort();
    const activeSubscriptions =
      activeSubscriptionsByUser.get(String(user._id)) || [];
    const primaryAddress =
      (user.defaultAddressId &&
        (user.addresses || []).find(
          (address) => String(address._id) === String(user.defaultAddressId)
        )) ||
      (user.addresses || [])[0] ||
      null;
    const primarySubscription =
      (user.defaultAddressId &&
        activeSubscriptions.find(
          (subscription) =>
            String(subscription.addressId) === String(user.defaultAddressId)
        )) ||
      activeSubscriptions[0] ||
      null;
    const addressSnapshot = primarySubscription?.addressSnapshot || {};
    return {
      id: String(user._id),
      userId: user.userId || "",
      name: user.name || "",
      fullName: user.name || "",
      firstName: user.firstName || "",
      lastName: user.lastName || "",
      email: user.email,
      phone: user.phone || "",
      memberSince: user.createdAt || null,
      plans,
      subscriptionStatuses,
      subscription: plans.join(", "),
      address:
        primaryAddress?.line1 || addressSnapshot.line1 || user.address || "",
      city: primaryAddress?.city || addressSnapshot.city || user.city || "",
      state: primaryAddress?.state || addressSnapshot.state || user.state || "",
      zip: primaryAddress?.zip || addressSnapshot.zip || user.zip || "",
    };
  });
}

function normalizeExclusionSet(values = []) {
  return new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
  );
}

function applyRecipientExclusions(recipients, options = {}) {
  const excludedUserIds = normalizeExclusionSet(options.excludedUserIds);
  const excludedEmails = normalizeExclusionSet(options.excludedEmails);
  const included = [];
  const excluded = [];

  for (const recipient of recipients) {
    const userId = String(recipient.id || recipient.userId || "").toLowerCase();
    const email = normalizeEmail(recipient.email);
    const excludedByAdmin =
      excludedUserIds.has(userId) ||
      excludedUserIds.has(String(recipient.userId || "").toLowerCase()) ||
      excludedEmails.has(email);
    if (excludedByAdmin) excluded.push({ ...recipient, excludedReason: "manual_exclusion" });
    else included.push(recipient);
  }

  return { included, excluded };
}

function publicRecipient(recipient) {
  return {
    id: recipient.id,
    userId: recipient.userId,
    name: recipient.name || recipient.fullName || "",
    email: recipient.email,
    phone: recipient.phone || "",
    plans: recipient.plans || [],
    subscriptionStatuses: recipient.subscriptionStatuses || [],
    address: recipient.address || "",
    city: recipient.city || "",
    state: recipient.state || "",
    zip: recipient.zip || "",
  };
}

async function resolveAudience(segmentInput, options = {}) {
  const segment = normalizeSegment(segmentInput);
  const adminEmail = normalizeEmail(process.env.MAIL_ADMIN || "getfixter@gmail.com");

  const [users, blacklist, suppressions] = await Promise.all([
    User.find({
      $or: [
        { role: "customer" },
        { role: { $exists: false } },
        { role: null },
        { role: "" },
      ],
      isActive: { $ne: false },
      email: { $exists: true, $nin: [null, ""] },
    })
      .select(
        "_id userId name firstName lastName email phone createdAt address city state zip addresses defaultAddressId role isActive"
      )
      .lean(),
    Blacklist.find().select("user email").lean(),
    EmailSuppression.find().select("email reason").lean(),
  ]);

  const userIds = users.map((user) => user._id);
  const candidateSubscriptions = userIds.length
    ? await Subscription.find({
        user: { $in: userIds },
        status: { $in: ["active", "trialing"] },
      })
        .select(
          "user subscriptionType status accessStatus stripeSubscriptionId currentPeriodEnd cancelAtPeriodEnd cancellationDate addressId addressSnapshot"
        )
        .lean()
    : [];

  const allEligible = buildEligibleRecipients({
    users,
    subscriptions: candidateSubscriptions,
    blacklist,
    suppressions,
    adminEmail,
  });
  const matchingRecipients = allEligible.filter((recipient) =>
    userMatchesSegment(recipient, segment)
  );
  const { included, excluded } = applyRecipientExclusions(
    matchingRecipients,
    options
  );

  return {
    segment,
    recipients: included,
    excludedRecipients: excluded,
    eligibleBeforeExclusions: matchingRecipients.length,
  };
}

async function resolveAudienceCounts() {
  const { recipients } = await resolveAudience("all");
  const counts = {
    all: recipients.length,
    subscribed: 0,
    not_subscribed: 0,
    basic: 0,
    plus: 0,
    premium: 0,
    elite: 0,
  };

  for (const recipient of recipients) {
    if (recipient.plans.length) counts.subscribed += 1;
    else counts.not_subscribed += 1;
    for (const plan of PLAN_SEGMENTS) {
      if (recipient.plans.includes(plan)) counts[plan] += 1;
    }
  }
  return counts;
}

module.exports = {
  SEGMENTS,
  applyRecipientExclusions,
  buildEligibleRecipients,
  normalizeEmail,
  normalizeSegment,
  publicRecipient,
  resolveAudience,
  resolveAudienceCounts,
};
