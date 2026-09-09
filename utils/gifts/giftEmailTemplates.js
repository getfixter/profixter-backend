const { PUBLIC_CONTACT_EMAIL } = require("../publicContact");

/**
 * The gift membership emails.
 *
 * A factory with the same shape as createCustomerEmailTemplates, merged into
 * the same TEMPLATES registry, so these are sent, logged, suppressed and shown
 * in the admin email log exactly like every other transactional email. Nothing
 * about the delivery path is new.
 *
 * WORDING RULE
 * A gift does not renew and nobody's card is on file for it. So none of these
 * may say "renews", "your card will be charged", "update your payment method"
 * or anything else implying a recurring relationship — the first two would be
 * false and the third would point at a payment method that does not exist.
 * They say the gift ENDS on a date, and offer starting a new membership. This
 * is asserted in the test suite rather than left to memory.
 */

function createGiftEmailTemplates({ escapeHtml, urls }) {
  const SUPPORT_EMAIL = PUBLIC_CONTACT_EMAIL;
  const safe = (value, fallback = "") => escapeHtml(String(value || fallback).trim());

  const button = (href, label) => `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:24px 0 8px;">
      <tr>
        <td style="border-radius:8px; background:#0F6E6E;">
          <a href="${href}" style="display:inline-block; padding:13px 26px; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:600; color:#ffffff; text-decoration:none; border-radius:8px;">${label}</a>
        </td>
      </tr>
    </table>`;

  const shell = (inner) => `
    <div style="font-family:Arial,Helvetica,sans-serif; font-size:15px; line-height:1.6; color:#1f2937; max-width:560px; margin:0 auto; padding:8px 0;">
      ${inner}
      <p style="margin:26px 0 0; color:#6b7280; font-size:13px;">Questions? ${SUPPORT_EMAIL}</p>
    </div>`;

  const months = (n) => `${n} month${Number(n) === 1 ? "" : "s"}`;

  return {
    /* ------------------------------ Purchaser ---------------------------- */
    gift_purchase_confirmation: ({
      name = "there",
      plan,
      durationMonths,
      recipientName,
      recipientEmail,
      amountPaid,
      giftNumber,
    }) => ({
      subject: `Your gift of ProFixter ${safe(plan)} is on its way`,
      html: shell(`
        <p style="margin:0 0 14px;">Hi ${safe(name)},</p>
        <p style="margin:0 0 14px;">
          Thank you. You have given <strong>${safe(recipientName)}</strong>
          ${months(durationMonths)} of ProFixter ${safe(plan)}.
        </p>
        <p style="margin:0 0 14px;">
          We have emailed an invitation to ${safe(recipientEmail)}. Their ${months(durationMonths)}
          begin when they claim it, so none of the time is lost while they get round to it.
        </p>
        <p style="margin:0 0 6px; color:#6b7280; font-size:14px;">
          Amount paid: <strong>${safe(amountPaid)}</strong><br>
          Gift reference: ${safe(giftNumber)}
        </p>
        <p style="margin:18px 0 0; color:#6b7280; font-size:14px;">
          This was a one-time payment. There is nothing further to pay, and it will not repeat.
        </p>
      `),
      text:
        `Hi ${name},\n\nThank you. You have given ${recipientName} ${months(durationMonths)} of ` +
        `ProFixter ${plan}.\n\nWe have emailed an invitation to ${recipientEmail}. Their ` +
        `${months(durationMonths)} begin when they claim it.\n\nAmount paid: ${amountPaid}\n` +
        `Gift reference: ${giftNumber}\n\nThis was a one-time payment. There is nothing further ` +
        `to pay, and it will not repeat.\n\n${SUPPORT_EMAIL}`,
    }),

    gift_claimed_purchaser: ({ name = "there", recipientName, plan, activeThrough }) => ({
      subject: `${safe(recipientName)} claimed your gift`,
      html: shell(`
        <p style="margin:0 0 14px;">Hi ${safe(name)},</p>
        <p style="margin:0 0 14px;">
          Good news &mdash; <strong>${safe(recipientName)}</strong> has claimed the ProFixter
          ${safe(plan)} membership you gave them. It runs through
          <strong>${safe(activeThrough)}</strong>.
        </p>
        <p style="margin:0; color:#6b7280; font-size:14px;">Nothing further is needed from you.</p>
      `),
      text:
        `Hi ${name},\n\n${recipientName} has claimed the ProFixter ${plan} membership you gave ` +
        `them. It runs through ${activeThrough}.\n\nNothing further is needed from you.\n\n${SUPPORT_EMAIL}`,
    }),

    /* ------------------------------ Recipient ---------------------------- */
    gift_invitation: ({ name = "there", from, plan, durationMonths, claimUrl }) => ({
      subject: `${safe(from)} sent you ${months(durationMonths)} of ProFixter ${safe(plan)}`,
      html: shell(`
        <p style="margin:0 0 14px;">Hi ${safe(name)},</p>
        <p style="margin:0 0 6px; font-size:17px;">
          <strong>${safe(from)}</strong> has given you ${months(durationMonths)} of
          ProFixter <strong>${safe(plan)}</strong>.
        </p>
        <p style="margin:0 0 14px;">
          That means a professional handyman at your home, with the visits and benefits
          included in ${safe(plan)}. There is nothing to pay and no card to enter.
        </p>
        ${button(claimUrl, "Claim your membership")}
        <p style="margin:16px 0 0; color:#6b7280; font-size:14px;">
          Your ${months(durationMonths)} start when you claim, not today &mdash; so you lose
          nothing by claiming when it suits you.
        </p>
      `),
      text:
        `Hi ${name},\n\n${from} has given you ${months(durationMonths)} of ProFixter ${plan}.\n\n` +
        `There is nothing to pay and no card to enter.\n\nClaim your membership: ${claimUrl}\n\n` +
        `Your ${months(durationMonths)} start when you claim, not today.\n\n${SUPPORT_EMAIL}`,
    }),

    gift_claim_reminder: ({ name = "there", from, plan, durationMonths, claimUrl }) => ({
      subject: `Still waiting for you: ${months(durationMonths)} of ProFixter ${safe(plan)}`,
      html: shell(`
        <p style="margin:0 0 14px;">Hi ${safe(name)},</p>
        <p style="margin:0 0 14px;">
          ${safe(from)} gave you ${months(durationMonths)} of ProFixter ${safe(plan)} and it is
          still here waiting. There is nothing to pay.
        </p>
        ${button(claimUrl, "Claim your membership")}
      `),
      text:
        `Hi ${name},\n\n${from} gave you ${months(durationMonths)} of ProFixter ${plan} and it is ` +
        `still waiting. There is nothing to pay.\n\nClaim it: ${claimUrl}\n\n${SUPPORT_EMAIL}`,
    }),

    /*
     * Handles both cases in one template, because they are the same message
     * with a different start date: a gift that begins today, and one queued
     * behind membership the recipient is already paying for.
     */
    gift_claimed: ({
      name = "there",
      from,
      plan,
      durationMonths,
      startsOn,
      activeThrough,
      queued,
    }) => ({
      subject: queued
        ? `Your gift membership is saved for later`
        : `Your ProFixter ${safe(plan)} membership is active`,
      html: shell(`
        <p style="margin:0 0 14px;">Hi ${safe(name)},</p>
        ${
          queued
            ? `<p style="margin:0 0 14px;">
                 Your ${months(durationMonths)} of ProFixter ${safe(plan)} from
                 ${safe(from)} is saved. It begins on <strong>${safe(startsOn)}</strong>, when your
                 current membership ends, and runs through <strong>${safe(activeThrough)}</strong>
                 &mdash; so none of the gifted time overlaps with what you are already paying for.
               </p>`
            : `<p style="margin:0 0 14px;">
                 Your ${months(durationMonths)} of ProFixter ${safe(plan)} from
                 ${safe(from)} is now active, through
                 <strong>${safe(activeThrough)}</strong>.
               </p>`
        }
        ${button(urls.schedule, "Book your first visit")}
        <p style="margin:16px 0 0; color:#6b7280; font-size:14px;">
          There is nothing to pay and no card on file for this membership.
        </p>
      `),
      text:
        `Hi ${name},\n\n` +
        (queued
          ? `Your ${months(durationMonths)} of ProFixter ${plan} from ${from} is saved. It begins ` +
            `on ${startsOn}, when your current membership ends, and runs through ${activeThrough}.`
          : `Your ${months(durationMonths)} of ProFixter ${plan} from ${from} is now active, ` +
            `through ${activeThrough}.`) +
        `\n\nBook a visit: ${urls.schedule}\n\nThere is nothing to pay and no card on file for ` +
        `this membership.\n\n${SUPPORT_EMAIL}`,
    }),

    /*
     * Ending, and expired.
     *
     * Both offer STARTING a membership, never renewing or resuming one. There
     * is nothing to renew: the gift was prepaid by somebody else and no card
     * of the recipient's has ever been involved.
     */
    gift_ending_soon: ({ name = "there", plan, endsOn, continueUrl }) => ({
      subject: `Your gift membership ends ${safe(endsOn)}`,
      html: shell(`
        <p style="margin:0 0 14px;">Hi ${safe(name)},</p>
        <p style="margin:0 0 14px;">
          Your gifted ProFixter ${safe(plan)} membership ends on
          <strong>${safe(endsOn)}</strong>. We hope your Fixter has been useful.
        </p>
        <p style="margin:0 0 14px;">
          If you would like to keep going, you can start your own membership on any plan.
          It is separate from the gift and paid by you.
        </p>
        ${button(continueUrl, "Continue with your own membership")}
      `),
      text:
        `Hi ${name},\n\nYour gifted ProFixter ${plan} membership ends on ${endsOn}.\n\nIf you ` +
        `would like to keep going, you can start your own membership on any plan. It is separate ` +
        `from the gift and paid by you.\n\n${continueUrl}\n\n${SUPPORT_EMAIL}`,
    }),

    gift_expired: ({ name = "there", plan, endedOn, continueUrl }) => ({
      subject: `Your gift membership has ended`,
      html: shell(`
        <p style="margin:0 0 14px;">Hi ${safe(name)},</p>
        <p style="margin:0 0 14px;">
          Your gifted ProFixter ${safe(plan)} membership ended on ${safe(endedOn)}.
          Thank you for letting us look after your home.
        </p>
        <p style="margin:0 0 14px;">
          You can start your own membership whenever you like &mdash; choose any plan, and
          it is yours.
        </p>
        ${button(continueUrl, "Start your membership")}
      `),
      text:
        `Hi ${name},\n\nYour gifted ProFixter ${plan} membership ended on ${endedOn}.\n\nYou can ` +
        `start your own membership whenever you like.\n\n${continueUrl}\n\n${SUPPORT_EMAIL}`,
    }),
  };
}

module.exports = { createGiftEmailTemplates };
