const mail = require("../emailService");
const { formatTermDate } = require("./giftPricing");
const { TIMEZONE } = require("./giftConfig");
const { occasionCopy } = require("./giftOccasions");
const { giftAccessState } = require("./giftAccess");

/**
 * The gift emails.
 *
 * Sent through the existing sendTx path so they inherit everything the
 * transactional system already does: logging into EmailLog, suppression
 * checks, admin visibility in the email log screen. No new mail system, no
 * second transport, no separate audit trail.
 *
 * WORDING RULE, CARRIED OVER FROM THE SMS WORK
 * None of these may use renewal or upcoming-charge language. A gift does not
 * renew and nobody's card is on file for it, so "your membership renews" would
 * be false and "update your payment method" would be meaningless. The wording
 * says the gift ENDS on a date, and offers a new membership rather than a
 * continuation of billing. A test asserts this.
 *
 * Every function here is best-effort and never throws into its caller. A gift
 * that has been paid for must not fail to exist because an email bounced.
 */

const CLIENT_URL = (process.env.CLIENT_URL || "https://www.profixter.com").replace(/\/+$/, "");

function planLabel(plan) {
  const value = String(plan || "");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function claimUrl(token) {
  return `${CLIENT_URL}/gift/claim/${encodeURIComponent(token)}`;
}

async function attempt(label, fn) {
  try {
    return await fn();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "gift_email_failed",
        email: label,
        error: String(error?.message || "unknown").slice(0, 200),
      })
    );
    return null;
  }
}

function logContextFor(gift, recipientEmail, emailType) {
  return {
    userId: gift.purchaser || null,
    customerEmail: recipientEmail,
    recipientEmail,
    emailType,
    source: "giftMembership",
  };
}

/**
 * Confirmation to the purchaser, invitation to the recipient.
 *
 * Sent together because they describe one event, and only from the webhook
 * once payment is confirmed — so nobody is told a gift exists before the money
 * has actually moved.
 */
async function sendGiftPurchaseEmails(gift, invitation) {
  const label = planLabel(gift.plan);
  const recipientName = `${gift.recipientFirstName || ""} ${gift.recipientLastName || ""}`.trim();

  await attempt("gift_purchase_confirmation", () =>
    mail.sendTx(
      "gift_purchase_confirmation",
      gift.purchaserSnapshot?.email,
      {
        name: gift.purchaserSnapshot?.name || "there",
        plan: label,
        durationMonths: gift.durationMonths,
        recipientName: recipientName || gift.recipientEmail,
        recipientEmail: gift.recipientEmail,
        amountPaid: `$${(Number(gift.amountPaidCents || 0) / 100).toFixed(2)}`,
        giftNumber: gift.giftNumber,
      },
      {
        bccAdmin: false,
        logContext: logContextFor(gift, gift.purchaserSnapshot?.email, "transactional"),
      }
    )
  );

  if (invitation?.token) {
    await attempt("gift_invitation", () =>
      mail.sendTx(
        "gift_invitation",
        gift.recipientEmail,
        {
          name: gift.recipientFirstName || "there",
          from: gift.purchaserSnapshot?.name || "A friend",
          plan: label,
          durationMonths: gift.durationMonths,
          claimUrl: claimUrl(invitation.token),
          occasion: gift.occasion,
          personalMessage: gift.personalMessage,
        },
        {
          bccAdmin: false,
          logContext: logContextFor(gift, gift.recipientEmail, "transactional"),
        }
      )
    );

    /*
     * And by text, if the purchaser also gave us a number.
     *
     * The SAME claim link, deliberately: one credential to expire, one to
     * revoke, and a recipient who opens whichever message reached them first
     * lands in the same place. Never instead of the email — email is what
     * claim identity binds on, so it always goes.
     *
     * Required lazily to keep the SMS system out of this module's import
     * graph for every gift that has no phone number, which is most of them.
     */
    if (gift.recipientPhone) {
      const { sendGiftInvitationSms } = require("./giftSms");
      await attempt("gift_invitation_sms", () =>
        sendGiftInvitationSms(gift, invitation, { claimUrl: claimUrl(invitation.token) })
      );
    }
  }
}

/** A fresh invitation, after an Admin re-issue. */
async function sendGiftInvitation(gift, invitation) {
  if (!invitation?.token) return null;
  return attempt("gift_invitation", () =>
    mail.sendTx(
      "gift_invitation",
      gift.recipientEmail,
      {
        name: gift.recipientFirstName || "there",
        from: gift.purchaserSnapshot?.name || "A friend",
        plan: planLabel(gift.plan),
        durationMonths: gift.durationMonths,
        claimUrl: claimUrl(invitation.token),
        occasion: gift.occasion,
        personalMessage: gift.personalMessage,
      },
      {
        bccAdmin: false,
        logContext: logContextFor(gift, gift.recipientEmail, "transactional"),
      }
    )
  );
}

/**
 * The gift has been claimed.
 *
 * Worth sending to the purchaser as well as the recipient: a realtor who bought
 * a gift for a client wants to know it landed, and that is the natural moment
 * to tell them.
 */
async function sendGiftClaimedEmails(gift) {
  const label = planLabel(gift.plan);
  const through = formatTermDate(gift.endAt);
  const queued = new Date(gift.startAt).getTime() > Date.now();

  await attempt("gift_claimed_recipient", () =>
    mail.sendTx(
      "gift_claimed",
      gift.recipientEmail,
      {
        name: gift.recipientFirstName || "there",
        from: gift.purchaserSnapshot?.name || "A friend",
        plan: label,
        durationMonths: gift.durationMonths,
        startsOn: formatTermDate(gift.startAt),
        activeThrough: through,
        queued,
      },
      {
        bccAdmin: false,
        logContext: logContextFor(gift, gift.recipientEmail, "transactional"),
      }
    )
  );

  await attempt("gift_claimed_purchaser", () =>
    mail.sendTx(
      "gift_claimed_purchaser",
      gift.purchaserSnapshot?.email,
      {
        name: gift.purchaserSnapshot?.name || "there",
        recipientName:
          `${gift.recipientFirstName || ""} ${gift.recipientLastName || ""}`.trim() ||
          gift.recipientEmail,
        plan: label,
        activeThrough: through,
      },
      {
        bccAdmin: false,
        logContext: logContextFor(gift, gift.purchaserSnapshot?.email, "transactional"),
      }
    )
  );
}

/** A nudge for a gift nobody has claimed yet. */
async function sendGiftClaimReminder(gift, invitation) {
  if (!invitation?.token) return null;
  return attempt("gift_claim_reminder", () =>
    mail.sendTx(
      "gift_claim_reminder",
      gift.recipientEmail,
      {
        name: gift.recipientFirstName || "there",
        from: gift.purchaserSnapshot?.name || "A friend",
        plan: planLabel(gift.plan),
        durationMonths: gift.durationMonths,
        claimUrl: claimUrl(invitation.token),
        occasion: gift.occasion,
        personalMessage: gift.personalMessage,
      },
      {
        bccAdmin: false,
        logContext: logContextFor(gift, gift.recipientEmail, "transactional"),
      }
    )
  );
}

/**
 * The gift is ending, and what to do about it.
 *
 * Offers a NEW membership in the recipient's own name. Deliberately not framed
 * as renewing or resuming anything: there is nothing to resume, and the
 * purchaser's payment method is not involved in any way.
 */
async function sendGiftEndingSoon(gift) {
  return attempt("gift_ending_soon", () =>
    mail.sendTx(
      "gift_ending_soon",
      gift.recipientEmail,
      {
        name: gift.recipientFirstName || "there",
        plan: planLabel(gift.plan),
        endsOn: formatTermDate(gift.endAt),
        continueUrl: `${CLIENT_URL}/membership`,
      },
      {
        bccAdmin: false,
        logContext: logContextFor(gift, gift.recipientEmail, "transactional"),
      }
    )
  );
}

/** The gift has ended. */
async function sendGiftExpired(gift) {
  return attempt("gift_expired", () =>
    mail.sendTx(
      "gift_expired",
      gift.recipientEmail,
      {
        name: gift.recipientFirstName || "there",
        plan: planLabel(gift.plan),
        endedOn: formatTermDate(gift.endAt),
        continueUrl: `${CLIENT_URL}/membership`,
      },
      {
        bccAdmin: false,
        logContext: logContextFor(gift, gift.recipientEmail, "transactional"),
      }
    )
  );
}

/* ------------------------- Admin lifecycle notices ------------------------ */

/*
 * EMAIL ONLY, all three of these. SMS is switched off until Twilio is
 * approved and nothing in the gift feature may depend on it.
 */

function adminAddress() {
  return String(process.env.MAIL_ADMIN || "getfixter@gmail.com").trim();
}

const money = (cents) => `$${(Number(cents || 0) / 100).toFixed(2)}`;

function recipientNameOf(gift) {
  return `${gift.recipientFirstName || ""} ${gift.recipientLastName || ""}`.trim() || "Unknown";
}

/**
 * How the recipient can be reached, as Admin needs to see it.
 *
 * A gift always has an email — that is what claim identity binds on — and
 * may additionally have a phone number the purchaser supplied. Both are shown
 * when both exist, so an admin chasing an unclaimed gift knows every channel
 * that was actually used.
 */
function recipientContact(gift) {
  const parts = [];
  if (gift.recipientEmail) parts.push(gift.recipientEmail);
  if (gift.recipientPhone) parts.push(gift.recipientPhone);
  return parts.length ? parts.join(" / ") : "unknown";
}

function addressLine(gift) {
  const a = gift.addressSnapshot || {};
  const parts = [a.line1, a.city, a.state, a.zip].filter((v) => String(v || "").trim());
  return parts.length ? parts.join(", ") : "Unknown";
}

function stamp(date) {
  if (!date) return "Unknown";
  return new Date(date).toLocaleString("en-US", {
    timeZone: TIMEZONE,
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Send an admin notice at most once per gift, ever.
 *
 * The stamp is CLAIMED BEFORE THE SEND, in one atomic update that only
 * succeeds if the field is still empty. Two webhook retries arriving
 * together, or a sweep overlapping itself, therefore cannot both get
 * through — the loser sees modifiedCount 0 and does nothing.
 *
 * If the send then fails the stamp is released, so the next run tries again
 * rather than the notice being lost to a transient SMTP error. The window
 * where a crash between send and release could cost one notice is accepted:
 * losing an internal notification is a far smaller harm than sending a
 * customer-facing duplicate, and this is the ordering that guarantees the
 * latter cannot happen.
 *
 * Never throws. A gift that has been paid for, or claimed, must not fail
 * because an email did.
 */
async function sendAdminNoticeOnce(gift, field, send, { Model } = {}) {
  const GiftModel = Model || require("../../models/GiftMembership");
  const at = new Date();

  let claimed;
  try {
    claimed = await GiftModel.updateOne(
      { _id: gift._id, $or: [{ [field]: null }, { [field]: { $exists: false } }] },
      { $set: { [field]: at } }
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "gift_admin_notice_stamp_failed",
        field,
        error: String(error?.message || "unknown").slice(0, 200),
      })
    );
    return { sent: false, reason: "stamp_failed" };
  }

  if (!claimed?.modifiedCount) return { sent: false, reason: "already_sent" };

  const result = await send();
  if (result === null || result === undefined) {
    try {
      await GiftModel.updateOne({ _id: gift._id, [field]: at }, { $set: { [field]: null } });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "gift_admin_notice_release_failed",
          field,
          giftNumber: gift.giftNumber,
        })
      );
    }
    console.warn(
      JSON.stringify({
        event: "gift_admin_notice_deferred",
        field,
        giftNumber: gift.giftNumber,
        note: "send failed; stamp released for retry",
      })
    );
    return { sent: false, reason: "send_failed" };
  }

  return { sent: true, at };
}

/**
 * Tell Admin a gift was bought, once the money has settled.
 *
 * Called from the webhook only for a session Stripe reports as paid or
 * no_payment_required. A created-but-abandoned Checkout Session is not a
 * sale and must never produce this email.
 */
async function sendGiftPurchasedAdminNotice(gift, { Model } = {}) {
  const to = adminAddress();
  if (!to) return { sent: false, reason: "no_admin_address" };

  const paidCents = Number(gift.amountPaidCents || 0);
  const discountCents = Number(gift.discountCents || 0);

  return sendAdminNoticeOnce(
    gift,
    "adminPurchasedEmailSentAt",
    () =>
      attempt("gift_purchased_admin", () =>
        mail.sendTx(
          "gift_purchased_admin",
          to,
          {
            giftNumber: gift.giftNumber,
            purchaserName: gift.purchaserSnapshot?.name || "Unknown",
            purchaserEmail: gift.purchaserSnapshot?.email || "unknown",
            recipientName: recipientNameOf(gift),
            recipientEmail: gift.recipientEmail || "unknown",
            recipientPhone: gift.recipientPhone || "",
            recipientContact: recipientContact(gift),
            plan: planLabel(gift.plan),
            durationMonths: gift.durationMonths,
            subtotal: money(gift.amountSubtotalCents),
            discount: discountCents ? `-${money(discountCents)}` : "None",
            tax: money(gift.taxCents),
            amountPaid: money(paidCents),
            purchasedAt: stamp(gift.purchasedAt || gift.createdAt),
            occasion: occasionCopy(gift.occasion).label,
            personalMessage: gift.personalMessage || "",
            /*
             * A gift can legitimately cost nothing: a 100% promotion code
             * produces a settled session with no payment at all. Worth
             * flagging so a $0.00 line is never mistaken for a fault.
             */
            wasFullyDiscounted: paidCents === 0,
            claimStatus: gift.status === "claimed" ? "Claimed" : "Not claimed yet",
          },
          { bccAdmin: false, logContext: logContextFor(gift, to, "transactional") }
        )
      ),
    { Model }
  );
}

/** Tell Admin the recipient claimed it, and where it landed. */
async function sendGiftClaimedAdminNotice(gift, { queued = false, Model } = {}) {
  const to = adminAddress();
  if (!to) return { sent: false, reason: "no_admin_address" };

  const isQueued = Boolean(queued) || new Date(gift.startAt).getTime() > Date.now();

  return sendAdminNoticeOnce(
    gift,
    "adminClaimedEmailSentAt",
    () =>
      attempt("gift_claimed_admin", () =>
        mail.sendTx(
          "gift_claimed_admin",
          to,
          {
            giftNumber: gift.giftNumber,
            purchaserName: gift.purchaserSnapshot?.name || "Unknown",
            purchaserEmail: gift.purchaserSnapshot?.email || "unknown",
            recipientName: recipientNameOf(gift),
            recipientEmail: gift.recipientEmail || "unknown",
            recipientPhone: gift.recipientPhone || "",
            recipientContact: recipientContact(gift),
            plan: planLabel(gift.plan),
            durationMonths: gift.durationMonths,
            claimedAt: stamp(gift.claimedAt),
            propertyAddress: addressLine(gift),
            startsOn: gift.startAt ? formatTermDate(gift.startAt) : "When current coverage ends",
            endsOn: gift.endAt ? formatTermDate(gift.endAt) : "Not set until it starts",
            giftState: giftAccessState(gift).state,
            queued: isQueued,
            activationNote: isQueued
              ? gift.startAt
                ? `It begins on ${formatTermDate(gift.startAt)}, when the paid membership at that property ends.`
                : "It begins when the paid membership at that property ends. The exact date is not known yet because that membership is still renewing."
              : "",
          },
          { bccAdmin: false, logContext: logContextFor(gift, to, "transactional") }
        )
      ),
    { Model }
  );
}

/**
 * Two weeks on and still unclaimed.
 *
 * The raw claim token is deliberately absent: it is a credential that grants
 * the membership to whoever holds it, and it belongs in the recipient's inbox
 * and nowhere else. Admin gets the gift reference, which is what the admin
 * screen searches on.
 */
async function sendGiftUnclaimedAdminNotice(gift, { daysUnclaimed, now = new Date(), Model } = {}) {
  const to = adminAddress();
  if (!to) return { sent: false, reason: "no_admin_address" };

  const purchased = gift.purchasedAt || gift.createdAt;
  const days =
    Number.isFinite(daysUnclaimed) && daysUnclaimed >= 0
      ? Math.floor(daysUnclaimed)
      : Math.floor((now.getTime() - new Date(purchased).getTime()) / (24 * 60 * 60 * 1000));

  return sendAdminNoticeOnce(
    gift,
    "adminUnclaimed14dEmailSentAt",
    () =>
      attempt("gift_unclaimed_admin", () =>
        mail.sendTx(
          "gift_unclaimed_admin",
          to,
          {
            giftNumber: gift.giftNumber,
            purchaserName: gift.purchaserSnapshot?.name || "Unknown",
            purchaserEmail: gift.purchaserSnapshot?.email || "unknown",
            recipientName: recipientNameOf(gift),
            recipientEmail: gift.recipientEmail || "unknown",
            recipientPhone: gift.recipientPhone || "",
            recipientContact: recipientContact(gift),
            plan: planLabel(gift.plan),
            durationMonths: gift.durationMonths,
            purchasedAt: stamp(purchased),
            daysUnclaimed: days,
            giftStatus: gift.status || "unknown",
            adminUrl: `${CLIENT_URL}/admin?tab=gifts`,
            invitationExpired: gift.claimTokenExpiresAt
              ? new Date(gift.claimTokenExpiresAt).getTime() <= now.getTime()
              : false,
          },
          { bccAdmin: false, logContext: logContextFor(gift, to, "transactional") }
        )
      ),
    { Model }
  );
}

/**
 * Tell Admin a gift was refunded.
 *
 * EMAIL ONLY. SMS is switched off until Twilio is approved, and nothing in
 * the gift feature may depend on it — this path must work with SMS disabled,
 * which it does because it never touches it.
 *
 * Sent to the admin address rather than bcc'd on a customer email, because
 * there is no customer email here: the recipient is deliberately not told
 * anything, since their access has not changed.
 */
async function sendGiftRefundAdminNotice(gift, { refund, refundStatus, giftState }) {
  const adminAddress = String(process.env.MAIL_ADMIN || "getfixter@gmail.com").trim();
  if (!adminAddress) return null;

  return attempt("gift_refunded_admin", () =>
    mail.sendTx(
      "gift_refunded_admin",
      adminAddress,
      {
        giftNumber: gift.giftNumber,
        purchaserName: gift.purchaserSnapshot?.name || "Unknown",
        purchaserEmail: gift.purchaserSnapshot?.email || "unknown",
        recipientName:
          `${gift.recipientFirstName || ""} ${gift.recipientLastName || ""}`.trim() || "Unknown",
        recipientEmail: gift.recipientEmail || "unknown",
        plan: planLabel(gift.plan),
        durationMonths: gift.durationMonths,
        refundAmount: money(refund?.amount),
        refundedTotal: money(gift.amountRefundedCents),
        amountPaid: money(gift.amountPaidCents),
        refundStatus: refundStatus || gift.refundStatus || "unknown",
        giftState: giftState || "unknown",
      },
      {
        bccAdmin: false,
        logContext: logContextFor(gift, adminAddress, "transactional"),
      }
    )
  );
}

module.exports = {
  claimUrl,
  planLabel,
  sendGiftClaimReminder,
  sendGiftClaimedEmails,
  sendGiftEndingSoon,
  sendGiftExpired,
  sendGiftInvitation,
  sendGiftPurchaseEmails,
  sendGiftRefundAdminNotice,
  sendGiftPurchasedAdminNotice,
  sendGiftClaimedAdminNotice,
  sendGiftUnclaimedAdminNotice,
};
