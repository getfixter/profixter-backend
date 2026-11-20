/**
 * Referral program emails to the REFERRER (registered in utils/emailService
 * TEMPLATES, editable in Admin > Communications like every other template).
 * New keys are held for an unconfirmed address (unconfirmedEmailPolicy), so a
 * reward and a mailing address are only ever written to a confirmed inbox.
 */
const { renderOperationalEmail } = require("../operationalEmail");

const site = () => String(process.env.CLIENT_URL || "https://www.profixter.com").replace(/\/+$/, "");
const rewardsUrl = () => `${site()}/account?referrals=1`;

module.exports = {
  referral_reward_pending: ({ name = "there", friend = "Your friend", amount = "", plan = "" }) =>
    renderOperationalEmail({
      subject: `${friend} joined Profixter - your ${amount} reward is pending`,
      event: "Your referral reward is pending",
      who: `${friend} started a${plan ? ` ${plan}` : ""} membership through your link.`,
      highlight: amount,
      rows: [["Status", "Pending"]],
      note: `Thanks, ${name}. The reward becomes ready when their second membership payment goes through. We'll then ask where to mail your check.`,
      action: { label: "See your referrals", url: rewardsUrl() },
      footer: "The reward is the lesser of $149 and what your friend paid for their first membership payment, after discounts and refunds, before tax.",
    }),

  referral_reward_ready: ({ name = "there", friend = "Your friend", amount = "" }) =>
    renderOperationalEmail({
      subject: `Your ${amount} referral reward is ready`,
      event: "Your referral reward is ready",
      who: `${friend}'s second membership payment went through.`,
      highlight: amount,
      rows: [["Status", "Ready"]],
      note: `Please confirm the name and mailing address for your check, ${name}. We mail it once Profixter has checked the payments.`,
      action: { label: "Confirm where to mail it", url: rewardsUrl() },
      footer: "For your security we'll ask you to sign in and confirm it's you first.",
    }),

  referral_payee_saved: ({ name = "there", payee = "", address = "" }) =>
    renderOperationalEmail({
      subject: "We saved where to mail your referral check",
      event: "Mailing details saved",
      who: payee ? `Payable to ${payee}` : "",
      rows: [["Mail to", address]],
      note: `If you didn't make this change, ${name}, call us right away at (631) 599-1363 and we'll hold the check.`,
      action: { label: "See your referrals", url: rewardsUrl() },
    }),

  referral_reward_mailed: ({ name = "there", amount = "", reference = "", mailedOn = "" }) =>
    renderOperationalEmail({
      subject: `Your ${amount} referral check is in the mail`,
      event: "Your referral check is in the mail",
      highlight: amount,
      rows: [
        ["Mailed", mailedOn],
        ["Check", reference],
      ],
      note: `Thank you for sharing Profixter, ${name}.`,
      action: { label: "Share your link again", url: rewardsUrl() },
    }),
};
