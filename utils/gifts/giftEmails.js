const mail = require("../emailService");
const { formatTermDate } = require("./giftPricing");

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

module.exports = {
  claimUrl,
  planLabel,
  sendGiftClaimReminder,
  sendGiftClaimedEmails,
  sendGiftEndingSoon,
  sendGiftExpired,
  sendGiftInvitation,
  sendGiftPurchaseEmails,
};
