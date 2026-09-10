const { sendTransactionalSms } = require("../sms/smsService");
const { toE164, maskPhone } = require("../sms/smsPhone");
const { giftSmsEnabled } = require("../sms/smsConfig");

/**
 * The gift invitation text.
 *
 * THE ONLY SMS THE GIFT FEATURE SENDS, and the only one in the whole system
 * that can go out while SMS_ENABLED is false. It has its own switch,
 * GIFT_SMS_ENABLED, and smsConfig.sendingAllowedFor releases that switch for
 * this notification type alone — booking reminders, membership notices and
 * the marketing campaigns all stay held shut by the master switch.
 *
 * WHY IT NEEDS ONE AT ALL
 * Every other notification has a fallback: the customer has an account, so
 * they have an email address and a screen to log into. A gift recipient has
 * neither. If the purchaser knows only their phone number, a text is the one
 * way to tell them a present exists.
 *
 * WHAT IT IS NOT
 * It is not identity. A number here was typed by a third party and verified
 * by nobody, so it decides whether we text somebody — never who they are.
 * Claim identity still binds on the email address, in giftService.
 *
 * Best-effort, like the gift emails: a text that fails to send must not undo
 * a purchase that has already been paid for.
 */
async function sendGiftInvitationSms(gift, invitation, { claimUrl } = {}) {
  const to = toE164(gift?.recipientPhone);
  if (!to) return { sent: false, reason: "no_phone" };
  if (!invitation?.token || !claimUrl) return { sent: false, reason: "no_claim_url" };

  /*
   * Checked here as well as inside the service so the log line below says
   * something true. Without it a disabled channel would be reported as
   * "queued", which is how somebody ends up believing a text went out.
   */
  if (!giftSmsEnabled()) {
    console.log(
      JSON.stringify({
        event: "gift_sms_skipped",
        reason: "gift_sms_disabled",
        giftNumber: gift.giftNumber,
        to: maskPhone(to),
      })
    );
  }

  try {
    const result = await sendTransactionalSms({
      notificationType: "GIFT_INVITATION",
      /*
       * One text per gift, forever. The gift number is unique and permanent,
       * so a replayed webhook or a re-issued invitation cannot text somebody
       * about the same present twice.
       */
      dedupeKey: `gift_invitation:${gift.giftNumber}`,
      phone: to,
      vars: {
        fromName: gift.purchaserSnapshot?.name || "",
        claimUrl,
      },
      source: "giftMembership",
    });

    console.log(
      JSON.stringify({
        event: "gift_sms_queued",
        giftNumber: gift.giftNumber,
        to: maskPhone(to),
        status: result?.status || "unknown",
      })
    );
    return { sent: Boolean(result?.ok), status: result?.status, id: result?.id };
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "gift_sms_failed",
        giftNumber: gift.giftNumber,
        to: maskPhone(to),
        error: String(error?.message || "unknown").slice(0, 200),
      })
    );
    return { sent: false, reason: "send_failed" };
  }
}

module.exports = { sendGiftInvitationSms };
