const crypto = require("crypto");
const User = require("../models/User");
const Booking = require("../models/Booking");
const Subscription = require("../models/Subscription");
const VisitEntitlement = require("../models/VisitEntitlement");
const StripeWebhookEvent = require("../models/StripeWebhookEvent");
const BookingSlotReservation = require("../models/BookingSlotReservation");
const ReservationTimeBucket = require("../models/ReservationTimeBucket");
const ReservationCapacityBucket = require("../models/ReservationCapacityBucket");
const RepAttribution = require("../models/RepAttribution");
const { normalizeEmail, normalizePhone } = require("../utils/identity");
const { syncGhlConversion } = require("../utils/ghlSync");
const mail = require("../utils/emailService");
const { createOrUpdateContact, addTag } = require("../utils/ghlContact");
const {
  cancelBookingWithReservation,
  promoteHeldReservationForBooking,
  reservationEngineEnabled,
} = require("../utils/slotReservationService");
const CalendarConfig = require("../models/CalendarConfig");
const SlotCounter = require("../models/SlotCounter");
const {
  stripe,
  getPlanPrice,
  retrieveStripeSubscription,
  upsertSubscriptionFromStripe,
  syncCustomerFromStripe,
  handlePaymentFailure,
} = require("../utils/subscriptionManagement");
const {
  applyOneTimePaymentSuccessToBooking,
  applyOneTimePaymentSuccessToEntitlement,
  oneTimeReservationProtectionExpiresAt,
  reservationIssueFromPromotionError,
} = require("../utils/oneTimeVisitPaymentFlow");

const ONE_TIME_PRODUCT_KIND = "one_time_handyman_visit";

function logWebhook(level, event, details = {}) {
  const payload = JSON.stringify({
    level,
    event,
    scope: "stripe_webhook",
    ...details,
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

function sha256(value) {
  if (!value) return undefined;
  return crypto
    .createHash("sha256")
    .update(String(value).trim().toLowerCase())
    .digest("hex");
}

function normPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return "1" + digits;
  return digits;
}

function cleanObject(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      const filtered = value.filter(
        (entry) => entry !== undefined && entry !== null && String(entry).trim() !== ""
      );
      if (!filtered.length) continue;
      out[key] = filtered;
      continue;
    }
    if (typeof value === "string" && value.trim() === "") continue;
    out[key] = value;
  }
  return out;
}

function buildUserData({ email, phone, externalId, fbp, fbc, clientIp, userAgent }) {
  return cleanObject({
    external_id: externalId ? [sha256(externalId)] : undefined,
    em: email ? [sha256(email)] : undefined,
    ph: phone ? [sha256(normPhone(phone))] : undefined,
    fbp: fbp || undefined,
    fbc: fbc || undefined,
    client_ip_address: clientIp || undefined,
    client_user_agent: userAgent || undefined,
  });
}

async function sendMetaCapi(body) {
  try {
    if (typeof fetch !== "function") {
      console.warn("Meta CAPI skipped: fetch not available");
      return;
    }

    const pixelId = process.env.FB_PIXEL_ID;
    const token = process.env.FB_ACCESS_TOKEN;
    if (!pixelId || !token) return;

    const url = `https://graph.facebook.com/v20.0/${pixelId}/events?access_token=${token}`;
    const payload = { data: [cleanObject(body)] };
    if (process.env.FB_TEST_CODE) {
      payload.test_event_code = process.env.FB_TEST_CODE;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    let json;
    try {
      json = await response.json();
    } catch {
      json = { raw: await response.text() };
    }

    if (!response.ok) {
      console.warn("Meta CAPI failed:", response.status, json);
    }
  } catch (error) {
    console.warn("Meta CAPI (webhook) failed:", error.message);
  }
}

async function findBestLeadMatch({ user }) {
  let doc = null;

  if (user?._id) {
    doc = await RepAttribution.findOne({ matchedUserId: user._id }).sort({
      assignedAt: -1,
      createdAt: -1,
    });
  }

  if (!doc) {
    const phoneNormalized = normalizePhone(user?.phone);
    if (phoneNormalized) {
      doc = await RepAttribution.findOne({
        phoneNormalized,
        status: { $in: ["active", "registered", "subscribed"] },
      }).sort({ assignedAt: -1, createdAt: -1 });
    }
  }

  if (!doc) {
    const emailNormalized = normalizeEmail(user?.email);
    if (emailNormalized) {
      doc = await RepAttribution.findOne({
        emailNormalized,
        status: { $in: ["active", "registered", "subscribed"] },
      }).sort({ assignedAt: -1, createdAt: -1 });
    }
  }

  return doc;
}

async function markLeadSubscribed({ user, subscription, plan, billingCycle, value }) {
  try {
    const match = await findBestLeadMatch({ user });
    if (!match) {
      console.log("No cold-lead match found on subscription for:", user.email);
      return;
    }

    match.matchedUserId = user._id;
    match.matchedSubscriptionId = subscription._id;
    match.emailRaw = user.email || match.emailRaw;
    match.emailNormalized = normalizeEmail(user.email) || match.emailNormalized;
    match.phoneRaw = user.phone || match.phoneRaw;
    match.phoneNormalized = normalizePhone(user.phone) || match.phoneNormalized;

    if (!match.fullName && user.name) match.fullName = user.name;
    if (!match.cityAtAssignment && user.city) match.cityAtAssignment = user.city;
    if (!match.stateAtAssignment && user.state) match.stateAtAssignment = user.state;

    match.status = "subscribed";
    match.conversionType = "subscribed";
    if (!match.registeredAt) match.registeredAt = new Date();
    if (!match.subscribedAt) match.subscribedAt = new Date();

    match.subscriptionPlan = plan || null;
    match.subscriptionBillingCycle = billingCycle || null;
    match.subscriptionValue = Number(value) || 0;
    match.commissionAmount = Number(value || 0) * Number(match.commissionRate || 0.5);
    match.lastSyncedAt = new Date();

    await match.save();

    try {
      await syncGhlConversion({
        repAttributionId: match._id,
        event: "subscribed",
      });
    } catch (syncErr) {
      console.error("GHL subscribed sync failed:", syncErr.message);
    }
  } catch (error) {
    console.error("markLeadSubscribed failed:", error.message);
  }
}

async function findUserForStripeObject(stripeObject) {
  const metadata = stripeObject?.metadata || {};

  if (stripeObject?.customer) {
    const byCustomer = await User.findOne({ stripeCustomerId: String(stripeObject.customer) });
    if (byCustomer) return byCustomer;
  }

  const metadataUserId = String(metadata.userId || "").trim();
  if (metadataUserId) {
    const byPublicId = await User.findOne({ userId: metadataUserId });
    if (byPublicId) return byPublicId;
  }

  const metadataEmail = String(metadata.email || "").trim().toLowerCase();
  if (metadataEmail) {
    const byEmail = await User.findOne({ email: metadataEmail });
    if (byEmail) return byEmail;
  }

  if (stripeObject?.customer) {
    try {
      const customer = await stripe.customers.retrieve(stripeObject.customer);
      const customerEmail = String(customer?.email || "").trim().toLowerCase();
      if (customerEmail) {
        const byCustomerEmail = await User.findOne({ email: customerEmail });
        if (byCustomerEmail) return byCustomerEmail;
      }
    } catch (error) {
      console.warn("Unable to retrieve Stripe customer during webhook:", error.message);
    }
  }

  return null;
}

async function releaseLegacyBookingCapacity(booking) {
  if (!booking?.date) return;
  const cfg = await CalendarConfig.findOne().lean();
  const tz = cfg?.timezone || "America/New_York";
  const ymd = ymdInTZ(new Date(booking.date), tz);
  const hh = hhmmInTZ(new Date(booking.date), tz);
  await SlotCounter.updateOne({ ymd, time: hh }, { $inc: { count: -1 } });
}

async function sendOneTimePaymentEmails({ booking, user, entitlement }) {
  const address = [booking.address, booking.city, booking.state, booking.zip]
    .filter(Boolean)
    .join(", ");

  try {
    await mail.sendTx(
      "one_time_visit_payment_received",
      booking.email || user.email,
      {
        name: booking.name || user.name || "there",
        bookingNumber: booking.bookingNumber,
        date: booking.date,
        service: booking.service,
        selectedTask: booking.selectedTask,
        address,
        price: `$${((entitlement?.priceCents || 9900) / 100).toFixed(0)}`,
        durationMinutes: entitlement?.durationMinutes || 90,
      },
      {
        bccAdmin: false,
        logContext: {
          bookingId: booking._id,
          bookingNumber: booking.bookingNumber,
          customerName: booking.name || user.name || "",
          customerEmail: booking.email || user.email || "",
          recipientName: booking.name || user.name || "",
          recipientEmail: booking.email || user.email || "",
          emailType: "billing",
          source: "stripeWebhookOneTime",
        },
      }
    );
  } catch (error) {
    console.error("one_time_visit_payment_received email failed:", error.message);
  }

  try {
    await mail.sendPromo(process.env.MAIL_ADMIN || "getfixter@gmail.com", {
      subject: `Paid One-Time Visit Pending Approval - ${booking.name || user.name || ""}`,
      html: `
        <h2>Paid One-Time Visit Pending Approval</h2>
        <ul>
          <li><strong>Booking #:</strong> ${booking.bookingNumber}</li>
          <li><strong>Name:</strong> ${booking.name || user.name || "-"}</li>
          <li><strong>Email:</strong> ${booking.email || user.email || "-"}</li>
          <li><strong>Phone:</strong> ${booking.phone || user.phone || "-"}</li>
          <li><strong>Task:</strong> ${booking.selectedTask || booking.service || "-"}</li>
          <li><strong>Date:</strong> ${mail.formatNYCTime(booking.date)}</li>
          <li><strong>Address:</strong> ${address || "-"}</li>
          <li><strong>Payment:</strong> Paid</li>
        </ul>
      `,
      logContext: {
        templateKey: "admin_one_time_visit_paid",
        bookingId: booking._id,
        bookingNumber: booking.bookingNumber,
        customerName: booking.name || user.name || "",
        customerEmail: booking.email || user.email || "",
        recipientEmail: process.env.MAIL_ADMIN || "getfixter@gmail.com",
        emailType: "admin",
        source: "stripeWebhookOneTime",
      },
    });
  } catch (error) {
    console.error("admin one-time payment email failed:", error.message);
  }
}

async function preserveHeldReservationAfterPromotionFailure({ booking, error, session }) {
  const holdExpiresAt = oneTimeReservationProtectionExpiresAt(booking?.date);
  const issueMessage =
    error?.message ||
    "Stripe payment succeeded, but reservation promotion failed.";

  const reservation = await BookingSlotReservation.findOneAndUpdate(
    { bookingId: booking._id, status: "held" },
    {
      $set: {
        holdExpiresAt,
        releaseReason: `Payment received; admin reservation review required. ${issueMessage}`.slice(0, 500),
      },
    },
    { new: true }
  );

  if (!reservation) {
    logWebhook("error", "one_time_reservation_hold_missing_after_payment", {
      stripeSessionId: session?.id || null,
      bookingId: String(booking._id),
      message: issueMessage,
    });
    return { holdExpiresAt: null, reservationId: null };
  }

  await Promise.all([
    ReservationTimeBucket.updateMany(
      { reservationId: reservation._id, status: "held" },
      { $set: { expiresAt: holdExpiresAt } }
    ),
    ReservationCapacityBucket.updateMany(
      { reservationId: reservation._id, status: "held" },
      { $set: { expiresAt: holdExpiresAt } }
    ),
  ]);

  logWebhook("error", "one_time_reservation_hold_preserved_for_admin_review", {
    stripeSessionId: session?.id || null,
    bookingId: String(booking._id),
    reservationId: String(reservation._id),
    holdExpiresAt,
    message: issueMessage,
    code: error?.code || null,
  });

  return { holdExpiresAt, reservationId: String(reservation._id) };
}

async function handleOneTimeCheckoutCompleted(session) {
  const metadata = session.metadata || {};
  const bookingId = metadata.bookingId || session.client_reference_id || null;
  const entitlementId = metadata.entitlementId || null;

  if (!bookingId) {
    logWebhook("error", "one_time_checkout_missing_booking_id", {
      stripeSessionId: session.id,
    });
    return null;
  }

  const booking = await Booking.findById(bookingId);
  if (!booking) {
    logWebhook("error", "one_time_checkout_booking_not_found", {
      stripeSessionId: session.id,
      bookingId,
    });
    return null;
  }

  const user = await User.findById(booking.user);
  if (!user) {
    logWebhook("error", "one_time_checkout_user_not_found", {
      stripeSessionId: session.id,
      bookingId,
    });
    return null;
  }

  if (session.customer && !user.stripeCustomerId) {
    user.stripeCustomerId = String(session.customer);
    await user.save();
  }

  const entitlement =
    (entitlementId && (await VisitEntitlement.findById(entitlementId))) ||
    (await VisitEntitlement.findOne({ bookingId: booking._id }).sort({
      updatedAt: -1,
    }));

  let reservationIssue = null;
  if (reservationEngineEnabled()) {
    try {
      await promoteHeldReservationForBooking({
        bookingId: booking._id,
        actorUser: user,
        createdByType: "system",
      });
    } catch (error) {
      let protection = { holdExpiresAt: null, reservationId: null };
      try {
        protection = await preserveHeldReservationAfterPromotionFailure({
          booking,
          error,
          session,
        });
      } catch (preserveError) {
        logWebhook("error", "one_time_reservation_preserve_failed", {
          stripeSessionId: session.id,
          bookingId: String(booking._id),
          promotionMessage: error.message,
          preserveMessage: preserveError.message,
        });
      }
      reservationIssue = reservationIssueFromPromotionError(
        error,
        session,
        protection.holdExpiresAt
      );
      logWebhook("warn", "one_time_reservation_promote_failed", {
        stripeSessionId: session.id,
        bookingId: String(booking._id),
        reservationId: protection.reservationId,
        protectedUntil: protection.holdExpiresAt,
        message: error.message,
        code: error.code || null,
      });
    }
  }

  applyOneTimePaymentSuccessToBooking(booking, { session, reservationIssue });
  await booking.save();

  if (entitlement) {
    applyOneTimePaymentSuccessToEntitlement(entitlement, session, booking._id);
    await entitlement.save();
  }

  try {
    const contactId = await createOrUpdateContact({
      name: user.name,
      email: user.email,
      phone: user.phone,
    });
    if (contactId) {
      await addTag(contactId, "one_time_visit_paid");
    }
  } catch (error) {
    console.error("One-time GHL sync failed:", error.message);
  }

  await sendOneTimePaymentEmails({ booking, user, entitlement });
  return { bookingId: String(booking._id), entitlementId: entitlement ? String(entitlement._id) : null };
}

async function handleOneTimeCheckoutExpired(session, status = "expired") {
  const metadata = session.metadata || {};
  const bookingId = metadata.bookingId || session.client_reference_id || null;
  const entitlementId = metadata.entitlementId || null;
  if (!bookingId) return null;

  const booking = await Booking.findById(bookingId);
  if (!booking || booking.paymentState === "paid") return null;

  if (reservationEngineEnabled()) {
    try {
      await cancelBookingWithReservation({
        bookingId: booking._id,
        createdByType: "system",
        reason: "One-time payment not completed",
      });
    } catch (error) {
      console.warn("Unable to release one-time reservation hold:", error.message);
    }
  } else {
    try {
      await releaseLegacyBookingCapacity(booking);
    } catch (error) {
      console.warn("Unable to release one-time legacy slot hold:", error.message);
    }
  }

  booking.status = "Canceled";
  booking.paymentState = status;
  booking.paymentStatus = status === "expired" ? "Expired" : "Failed";
  await booking.save();

  const entitlement =
    (entitlementId && (await VisitEntitlement.findById(entitlementId))) ||
    (await VisitEntitlement.findOne({ bookingId: booking._id }).sort({
      updatedAt: -1,
    }));
  if (entitlement && entitlement.status === "pending_payment") {
    entitlement.status = status === "expired" ? "expired" : "payment_failed";
    entitlement.stripeCheckoutSessionId =
      session.id || entitlement.stripeCheckoutSessionId;
    await entitlement.save();
  }

  return { bookingId: String(booking._id), status };
}

async function handleCheckoutCompleted(session) {
  if (isOneTimeCheckoutSession(session)) {
    return handleOneTimeCheckoutCompleted(session);
  }

  let email = session.customer_email || session?.customer_details?.email || null;

  if (!email && session.customer) {
    const customer = await stripe.customers.retrieve(session.customer);
    email = customer?.email || null;
  }

  if (!email) {
    logWebhook("warn", "checkout_completed_missing_email", {
      stripeSessionId: session.id,
    });
    return;
  }

  const user = await User.findOne({ email: String(email).toLowerCase() });
  if (!user) {
    logWebhook("warn", "checkout_completed_user_not_found", {
      stripeSessionId: session.id,
      hasEmail: !!email,
    });
    return;
  }

  if (session.customer && !user.stripeCustomerId) {
    user.stripeCustomerId = String(session.customer);
    await user.save();
  }

  const stripeSubscriptionId = session.subscription ? String(session.subscription) : null;
  if (!stripeSubscriptionId) {
    logWebhook("error", "checkout_completed_missing_subscription_id", {
      stripeSessionId: session.id,
      userId: String(user._id),
    });
    return;
  }

  const stripeSubscription = await retrieveStripeSubscription(stripeSubscriptionId);

  const subscription = await upsertSubscriptionFromStripe({
    stripeSubscription,
    user,
    addressIdHint: session.metadata?.addressId || session.client_reference_id || null,
    stripeCheckoutSessionId: session.id,
  });

  const plan = String(subscription.subscriptionType || "").toLowerCase();
  const billingCycle = subscription.billingCycle || "monthly";
  const value = subscription.planPrice || getPlanPrice(plan);
  const currency = "USD";
  const now = new Date();

  await markLeadSubscribed({
    user,
    subscription,
    plan,
    billingCycle,
    value,
  });

  try {
    const contactId = await createOrUpdateContact({
      name: user.name,
      email: user.email,
      phone: user.phone,
    });
    if (contactId) {
      await addTag(contactId, "subscription_purchased");
    }
  } catch (error) {
    console.error("Stripe purchase GHL sync failed:", error.message);
  }

  const prevLP = user.lastPurchase || {};
  const confirmationToken = crypto.randomUUID();

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        stripeCustomerId: session.customer ? String(session.customer) : user.stripeCustomerId || null,
        lastPurchase: {
          ...prevLP,
          token: confirmationToken,
          stripeSessionId: session.id,
          plan,
          value,
          currency,
          createdAt: now,
          addressId: subscription.addressId || null,
          billingCycle,
        },
      },
    }
  );

  const userData = buildUserData({
    email: String(email).toLowerCase(),
    phone: prevLP.phone || user.phone || "",
    externalId: user.userId || String(user._id),
    fbp: prevLP.fbp || session.metadata?.fbp,
    fbc: prevLP.fbc || session.metadata?.fbc,
    clientIp: prevLP.clientIp,
    userAgent: prevLP.userAgent,
  });

  const hasStrongId = !!(
    userData.external_id ||
    userData.em ||
    userData.ph ||
    userData.fbp ||
    userData.fbc
  );

  if (hasStrongId) {
    await sendMetaCapi({
      event_name: "Purchase",
      event_time: Math.floor(Date.now() / 1000),
      event_id: prevLP.eventId || `sess_${session.id}`,
      action_source: "website",
      event_source_url:
        prevLP.sourceUrl ||
        session.metadata?.source_url ||
        process.env.CLIENT_URL ||
        "https://www.profixter.com",
      custom_data: { currency, value, plan, billingCycle },
      user_data: userData,
    });
  }

  await mail.sendTx(
    "subscription_started",
    user.email,
    {
      name: user.name || email.split("@")[0],
      plan: (plan || "").replace(/^./, (char) => char.toUpperCase()),
      billingCycle,
      address: subscription.addressSnapshot
        ? `${subscription.addressSnapshot.line1}, ${subscription.addressSnapshot.city}, ${subscription.addressSnapshot.state}`
        : null,
    },
    {
      bccAdmin: false,
      logContext: {
        userId: user._id,
        customerName: user.name || "",
        customerEmail: user.email,
        recipientName: user.name || "",
        recipientEmail: user.email,
        emailType: "billing",
        source: "stripeWebhook",
      },
    }
  );

  await mail.sendPromo(process.env.MAIL_ADMIN || "getfixter@gmail.com", {
    subject: `New Subscription: ${plan.toUpperCase()} - ${user.name || email}`,
    html: `
      <h2>New Subscription Activated</h2>
      <p><strong>Plan:</strong> ${plan.toUpperCase()} ($${value})</p>
      <p><strong>Billing:</strong> ${billingCycle.toUpperCase()}</p>
      <p><strong>Name:</strong> ${user.name || ""}</p>
      <p><strong>Phone:</strong> ${user.phone || "-"}</p>
      <p><strong>Email:</strong> ${user.email}</p>
      <p><strong>User ID:</strong> ${user.userId}</p>
      <p><strong>Address:</strong> ${
        subscription.addressSnapshot
          ? `${subscription.addressSnapshot.line1}, ${subscription.addressSnapshot.city}, ${subscription.addressSnapshot.state} ${subscription.addressSnapshot.zip}`
          : "No address assigned"
      }</p>
    `,
    logContext: {
      templateKey: "admin_subscription_started",
      userId: user._id,
      customerName: user.name || "",
      customerEmail: user.email,
      recipientEmail: process.env.MAIL_ADMIN || "getfixter@gmail.com",
      emailType: "admin",
      source: "stripeWebhook",
    },
  });
}

async function syncStripeSubscriptionRecord(stripeSubscription) {
  let canonicalStripeSubscription = stripeSubscription;

  if (
    stripeSubscription?.id &&
    String(stripeSubscription?.status || "").toLowerCase() !== "canceled"
  ) {
    canonicalStripeSubscription = await retrieveStripeSubscription(String(stripeSubscription.id));
  }

  const metadata = canonicalStripeSubscription?.metadata || {};
  if (!metadata.userId || !metadata.addressId) {
    logWebhook("warn", "subscription_sync_missing_metadata", {
      stripeSubscriptionId: canonicalStripeSubscription.id,
      customerId: canonicalStripeSubscription.customer,
      hasUserId: !!metadata.userId,
      hasAddressId: !!metadata.addressId,
      status: canonicalStripeSubscription.status,
    });
  }

  const user = await findUserForStripeObject(canonicalStripeSubscription);
  if (!user) {
    logWebhook("error", "subscription_sync_user_not_found", {
      stripeSubscriptionId: canonicalStripeSubscription.id,
      customerId: canonicalStripeSubscription.customer,
      metadataUserId: metadata.userId || null,
      metadataEmail: metadata.email || null,
    });
    return null;
  }

  // Capture pre-upsert state for email transition detection.
  // This prevents duplicate emails: the self-serve cancel route sends
  // subscription_cancellation_scheduled immediately and sets cancelAtPeriodEnd=true locally,
  // so when this webhook fires the transition is no longer detected here.
  const existingSub = await Subscription.findOne({
    stripeSubscriptionId: canonicalStripeSubscription.id,
  });
  const wasScheduledForCancellation = existingSub?.cancelAtPeriodEnd === true;
  const wasAlreadyCanceled = existingSub?.status === "canceled";
  const hadPaymentFailureCancellation = existingSub?.cancellationReason === "payment_failed";

  const incomingStatus = String(canonicalStripeSubscription?.status || "").toLowerCase();
  const incomingCancelAtPeriodEnd = !!canonicalStripeSubscription.cancel_at_period_end;

  const subscription = await upsertSubscriptionFromStripe({
    stripeSubscription: canonicalStripeSubscription,
    user,
    addressIdHint: canonicalStripeSubscription.metadata?.addressId || null,
  });

  if (!subscription) return null;

  const addrStr = subscription.addressSnapshot
    ? `${subscription.addressSnapshot.line1}, ${subscription.addressSnapshot.city}, ${subscription.addressSnapshot.state}`
    : null;
  const planStr = (subscription.subscriptionType || "").replace(/^./, (c) => c.toUpperCase());

  // Send cancellation_scheduled email only on the transition false → true.
  if (incomingCancelAtPeriodEnd && !wasScheduledForCancellation) {
    try {
      await mail.sendTx("subscription_cancellation_scheduled", user.email, {
        name: user.name || user.email.split("@")[0],
        plan: planStr,
        address: addrStr,
        accessEndDate: subscription.cancellationDate
          ? mail.formatNYCTime(subscription.cancellationDate.toISOString())
          : null,
      }, {
        bccAdmin: false,
        logContext: {
          userId: user._id,
          customerName: user.name || "",
          customerEmail: user.email,
          recipientName: user.name || "",
          recipientEmail: user.email,
          emailType: "billing",
          source: "stripeWebhook",
        },
      });
    } catch (emailErr) {
      console.error("subscription_cancellation_scheduled email failed:", emailErr.message);
    }
  }

  // Send subscription_canceled email only on the transition → canceled,
  // and only when not caused by payment failure (payment_failed email covers that case).
  if (incomingStatus === "canceled" && !wasAlreadyCanceled && !hadPaymentFailureCancellation) {
    try {
      const endedDate = subscription.cancellationDate || subscription.currentPeriodEnd;
      await mail.sendTx("subscription_canceled", user.email, {
        name: user.name || user.email.split("@")[0],
        plan: planStr,
        address: addrStr,
        canceledDate: endedDate ? mail.formatNYCTime(endedDate.toISOString()) : null,
      }, {
        bccAdmin: false,
        logContext: {
          userId: user._id,
          customerName: user.name || "",
          customerEmail: user.email,
          recipientName: user.name || "",
          recipientEmail: user.email,
          emailType: "billing",
          source: "stripeWebhook",
        },
      });
    } catch (emailErr) {
      console.error("subscription_canceled email failed:", emailErr.message);
    }
  }

  return subscription;
}

async function handleInvoicePaid(invoice) {
  if (!invoice?.subscription) return;

  const stripeSubscription = await retrieveStripeSubscription(String(invoice.subscription));

  const subscription = await syncStripeSubscriptionRecord(stripeSubscription);
  if (!subscription) return;

  subscription.latestPaymentDate = invoice.status_transitions?.paid_at
    ? new Date(invoice.status_transitions.paid_at * 1000)
    : new Date(invoice.created * 1000);
  subscription.latestInvoiceId = invoice.id || subscription.latestInvoiceId || null;
  subscription.latestInvoiceStatus = invoice.status || subscription.latestInvoiceStatus || null;
  await subscription.save();
  return subscription;
}

const ymdInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(d);
const hhmmInTZ = (d, tz) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);

function isOneTimeCheckoutSession(session) {
  return (
    String(session?.mode || "").toLowerCase() === "payment" &&
    session?.metadata?.productKind === ONE_TIME_PRODUCT_KIND
  );
}

async function handleInvoicePaymentFailed(invoice) {
  if (!invoice?.subscription) return;

  const stripeSubscription = await retrieveStripeSubscription(String(invoice.subscription));
  const billingReason = String(invoice.billing_reason || "").toLowerCase();

  const user = await findUserForStripeObject(stripeSubscription);

  // Send payment_failed email — fires once per invoice failure event (Stripe deduplicates).
  // Guard: only send to a real customer email, never to the admin address.
  const adminEmail = (process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();
  const isRealCustomer = user && user.email && user.email.toLowerCase() !== adminEmail;

  if (isRealCustomer) {
    try {
      const sub = await Subscription.findOne({ stripeSubscriptionId: stripeSubscription.id });
      const plan = sub?.subscriptionType
        ? sub.subscriptionType.replace(/^./, (c) => c.toUpperCase())
        : null;
      const amount = invoice.amount_due ? `$${(invoice.amount_due / 100).toFixed(2)}` : null;
      const billingDate = invoice.created
        ? mail.formatNYCTime(new Date(invoice.created * 1000).toISOString())
        : null;

      await mail.sendTx("payment_failed", user.email, {
        name: user.name || user.email.split("@")[0],
        plan,
        amount,
        billingDate,
      }, {
        bccAdmin: false,
        logContext: {
          userId: user._id,
          customerName: user.name || "",
          customerEmail: user.email,
          recipientName: user.name || "",
          recipientEmail: user.email,
          emailType: "billing",
          source: "stripeWebhook",
        },
      });
    } catch (emailErr) {
      console.error("payment_failed email failed:", emailErr.message);
    }
  }

  if (billingReason === "subscription_cycle") {
    if (!user) {
      console.warn("No local user found for failed recurring invoice:", invoice.id);
      return;
    }
    await handlePaymentFailure(invoice, stripeSubscription, user);
    return;
  }

  await handlePaymentFailure(invoice, stripeSubscription, user);
}

async function handleCustomerUpdated(customer) {
  const user = await syncCustomerFromStripe(customer?.id || null);
  return user ? { userId: String(user._id) } : null;
}

async function handlePaymentMethodAttached(paymentMethod) {
  const customerId = paymentMethod?.customer ? String(paymentMethod.customer) : null;
  if (!customerId) return null;
  const user = await syncCustomerFromStripe(customerId);
  if (!user) return null;

  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: "all",
    limit: 100,
    expand: ["data.items.data.price", "data.schedule", "data.latest_invoice.payment_intent"],
  });

  let synced = 0;
  for (const stripeSubscription of subscriptions.data || []) {
    const updated = await upsertSubscriptionFromStripe({
      stripeSubscription,
      user,
      addressIdHint: stripeSubscription.metadata?.addressId || null,
    });
    if (updated) synced++;
  }
  return { userId: String(user._id), synced };
}

function eventStripeIds(event) {
  const object = event?.data?.object || {};
  return {
    stripeCustomerId: object.customer ? String(object.customer) : object.id?.startsWith?.("cus_") ? object.id : null,
    stripeSubscriptionId:
      object.subscription
        ? String(object.subscription)
        : object.id?.startsWith?.("sub_")
          ? object.id
          : null,
  };
}

const WEBHOOK_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

async function beginWebhookEvent(event) {
  const ids = eventStripeIds(event);
  const existing = await StripeWebhookEvent.findOne({ eventId: event.id });

  if (existing?.status === "completed") {
    return { duplicate: true, retryLater: false, record: existing, ...ids };
  }

  if (existing) {
    const staleBefore = new Date(Date.now() - WEBHOOK_PROCESSING_TIMEOUT_MS);
    const claimed = await StripeWebhookEvent.findOneAndUpdate(
      {
        _id: existing._id,
        status: { $ne: "completed" },
        $or: [
          { status: "failed" },
          { status: "processing", updatedAt: { $lte: staleBefore } },
        ],
      },
      {
        $set: {
          status: "processing",
          lastError: null,
          eventType: event.type,
          stripeCustomerId: ids.stripeCustomerId,
          stripeSubscriptionId: ids.stripeSubscriptionId,
        },
      },
      { new: true }
    );

    return {
      duplicate: !claimed,
      retryLater: !claimed,
      record: claimed || existing,
      ...ids,
    };
  }

  try {
    const record = await StripeWebhookEvent.create({
      eventId: event.id,
      eventType: event.type,
      stripeCustomerId: ids.stripeCustomerId,
      stripeSubscriptionId: ids.stripeSubscriptionId,
      status: "processing",
    });
    return { duplicate: false, record, ...ids };
  } catch (error) {
    if (error?.code === 11000) {
      const concurrent = await StripeWebhookEvent.findOne({ eventId: event.id });
      return {
        duplicate: true,
        retryLater: concurrent?.status !== "completed",
        record: concurrent,
        ...ids,
      };
    }
    throw error;
  }
}

module.exports = async (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    logWebhook("error", "webhook_config_missing", {
      missing: ["STRIPE_WEBHOOK_SECRET"],
    });
    return res.status(503).send("Webhook configuration missing");
  }

  try {
    const rawBody = req.rawBody ? req.rawBody : req.body;
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logWebhook("error", "webhook_signature_failed", {
      message: err.message,
    });
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const eventState = await beginWebhookEvent(event);
    logWebhook("info", "webhook_event_received", {
      stripeEventId: event.id,
      stripeEventType: event.type,
      stripeCustomerId: eventState.stripeCustomerId,
      stripeSubscriptionId: eventState.stripeSubscriptionId,
      duplicate: eventState.duplicate,
    });

    if (eventState.duplicate) {
      if (eventState.retryLater) {
        return res.status(409).send("Webhook event is already processing");
      }
      return res.sendStatus(200);
    }

    let syncResult = null;
    switch (event.type) {
      case "checkout.session.completed":
        syncResult = await handleCheckoutCompleted(event.data.object);
        break;

      case "checkout.session.expired":
        if (isOneTimeCheckoutSession(event.data.object)) {
          syncResult = await handleOneTimeCheckoutExpired(event.data.object, "expired");
        }
        break;

      case "payment_intent.payment_failed":
        if (event.data.object?.metadata?.productKind === ONE_TIME_PRODUCT_KIND) {
          syncResult = await handleOneTimeCheckoutExpired(
            {
              id: event.data.object.metadata?.stripeCheckoutSessionId || null,
              metadata: event.data.object.metadata,
              client_reference_id: event.data.object.metadata?.bookingId || null,
            },
            "failed"
          );
        }
        break;

      case "customer.subscription.created":
        syncResult = await syncStripeSubscriptionRecord(event.data.object);
        break;

      case "customer.subscription.updated":
        syncResult = await syncStripeSubscriptionRecord(event.data.object);
        break;

      case "customer.subscription.deleted":
        syncResult = await syncStripeSubscriptionRecord(event.data.object);
        break;

      case "invoice.paid":
        syncResult = await handleInvoicePaid(event.data.object);
        break;

      case "invoice.payment_failed":
        syncResult = await handleInvoicePaymentFailed(event.data.object);
        break;

      case "invoice.payment_action_required":
        // 3DS authentication required for a renewal invoice.
        // Stripe retries automatically; sync state without cutting access.
        if (event.data.object?.subscription) {
          try {
            const sub = await retrieveStripeSubscription(
              String(event.data.object.subscription)
            );
            syncResult = await syncStripeSubscriptionRecord(sub);
          } catch (syncErr) {
            console.warn(
              "invoice.payment_action_required sync failed:",
              syncErr.message
            );
          }
        }
        break;

      case "customer.updated":
        syncResult = await handleCustomerUpdated(event.data.object);
        break;

      case "payment_method.attached":
        syncResult = await handlePaymentMethodAttached(event.data.object);
        break;

      default:
        break;
    }

    await StripeWebhookEvent.updateOne(
      { eventId: event.id },
      {
        $set: {
          status: "completed",
          processedAt: new Date(),
          lastError: null,
        },
      }
    );
    logWebhook("info", "webhook_event_synced", {
      stripeEventId: event.id,
      stripeEventType: event.type,
      stripeCustomerId: eventState.stripeCustomerId,
      stripeSubscriptionId: eventState.stripeSubscriptionId,
      syncResult: syncResult?._id ? String(syncResult._id) : syncResult || null,
    });
    return res.sendStatus(200);
  } catch (err) {
    if (event?.id) {
      await StripeWebhookEvent.updateOne(
        { eventId: event.id },
        {
          $set: {
            status: "failed",
            lastError: err?.message || "Unknown webhook error",
          },
        }
      ).catch(() => {});
    }
    logWebhook("error", "webhook_handler_failed", {
      stripeEventId: event?.id || null,
      stripeEventType: event?.type || null,
      message: err?.message || "Unknown webhook error",
    });
    return res.status(500).send("Server error");
  }
};
