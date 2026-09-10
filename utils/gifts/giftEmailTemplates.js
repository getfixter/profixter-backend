const { PUBLIC_CONTACT_EMAIL } = require("../publicContact");
const { occasionCopy } = require("./giftOccasions");

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

  /*
   * The gift card, for email.
   *
   * Nested tables, bgcolor attributes and inline styles only. No flexbox, no
   * grid, no background-image, no web font, no class — Outlook strips or
   * ignores all of them, and the card is the one thing in this message that
   * must survive. The webpage version is richer; this has to promise the same
   * thing, not reproduce it.
   *
   * The gold rule under the title is a coloured table cell rather than a
   * border, because borders on empty elements collapse in several clients.
   */
  const giftCardBlock = ({ occasion, plan, durationMonths, from, toName, message }) => {
    const copy = occasionCopy(occasion);
    const messageRow = message
      ? `
            <tr>
              <td style="padding:18px 28px 0;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                  <tr>
                    <td width="3" bgcolor="#D4A574" style="width:3px; line-height:1px; font-size:1px;">&nbsp;</td>
                    <td style="padding-left:14px; font-family:Georgia,'Times New Roman',serif; font-style:italic; font-size:16px; line-height:1.5; color:#4A4438;">${safe(
                      message
                    ).replace(/\n/g, "<br>")}</td>
                  </tr>
                </table>
              </td>
            </tr>`
      : "";

    return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:520px; margin:0 auto; border-radius:14px; overflow:hidden; border-collapse:separate;">
      <!-- navy face -->
      <tr>
        <td bgcolor="#0B1628" style="background-color:#0B1628; padding:28px 28px 26px;">
          <p style="margin:0 0 16px; font-family:Arial,Helvetica,sans-serif; font-size:15px; font-weight:bold; letter-spacing:1px; color:#EEF2FF;">
            <span style="color:#306EEC;">PRO</span>FIXTER
          </p>
          <p style="margin:0 0 6px; font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:2.4px; text-transform:uppercase; color:#A8BEE2;">
            ${safe(copy.kicker)}
          </p>
          <p style="margin:0 0 4px; font-family:Georgia,'Times New Roman',serif; font-size:30px; line-height:1.15; color:#E8CFAE;">
            ${safe(copy.title)}
          </p>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:16px 0 0;">
            <tr><td width="54" height="2" bgcolor="#D4A574" style="width:54px; height:2px; line-height:2px; font-size:1px;">&nbsp;</td></tr>
          </table>
          <p style="margin:18px 0 0; font-family:Arial,Helvetica,sans-serif; font-size:16px; font-weight:bold; letter-spacing:1px; text-transform:uppercase; color:#EEF2FF;">
            ${months(durationMonths)} of ProFixter ${safe(plan)}
          </p>
          <p style="margin:6px 0 0; font-family:Arial,Helvetica,sans-serif; font-size:11px; letter-spacing:2px; text-transform:uppercase; color:#8AA2CC;">
            Handyman Membership
          </p>
        </td>
      </tr>
      <!-- cream face -->
      <tr>
        <td bgcolor="#FAF8F4" style="background-color:#FAF8F4; padding:22px 28px 26px;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
            <tr>
              <td style="font-family:Arial,Helvetica,sans-serif; font-size:10px; letter-spacing:1.8px; text-transform:uppercase; color:#9A8C7A; padding-bottom:3px;">To</td>
              <td style="font-family:Arial,Helvetica,sans-serif; font-size:10px; letter-spacing:1.8px; text-transform:uppercase; color:#9A8C7A; padding-bottom:3px;">From</td>
            </tr>
            <tr>
              <td style="font-family:Arial,Helvetica,sans-serif; font-size:17px; font-weight:bold; color:#1A1B1D; padding-right:14px;">${safe(
                toName,
                "there"
              )}</td>
              <td style="font-family:Arial,Helvetica,sans-serif; font-size:17px; font-weight:bold; color:#1A1B1D;">${safe(
                from
              )}</td>
            </tr>
          </table>
        </td>
      </tr>${messageRow}
      <tr><td bgcolor="#FAF8F4" style="background-color:#FAF8F4; height:8px; line-height:8px; font-size:1px;">&nbsp;</td></tr>
    </table>`;
  };

  /* The gift CTA: warm metal, dark text, and a real tap target. */
  const giftButton = (href, label) => `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:26px auto 6px;">
      <tr>
        <td bgcolor="#D4A574" style="border-radius:10px; background-color:#D4A574;">
          <a href="${href}" style="display:inline-block; padding:16px 38px; font-family:Arial,Helvetica,sans-serif; font-size:16px; font-weight:bold; letter-spacing:0.4px; color:#1A1206; text-decoration:none; border-radius:10px;">${label}</a>
        </td>
      </tr>
    </table>`;

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

    /* -------------------------------- Admin ------------------------------ */
    /*
     * A gift was bought and the money has settled.
     *
     * Sent from the webhook once Stripe reports the session paid, or
     * no_payment_required for a legitimate 100% promotion code. Never on
     * session creation: an abandoned checkout is not a sale and must not
     * look like one in the inbox.
     *
     * EMAIL ONLY. SMS stays switched off until Twilio is approved.
     *
     * Carries no card details, no payment method, no Stripe ids beyond the
     * gift's own reference. The money is described by what it was, not by
     * how it was taken.
     */
    gift_purchased_admin: ({
      giftNumber,
      purchaserName,
      purchaserEmail,
      recipientName,
      recipientEmail,
      recipientPhone,
      plan,
      durationMonths,
      subtotal,
      discount,
      tax,
      amountPaid,
      purchasedAt,
      occasion,
      personalMessage,
      wasFullyDiscounted,
      claimStatus,
    }) => ({
      subject: "New Gift Membership Purchased - Profixter",
      html: shell(`
        <p style="margin:0 0 14px; font-size:17px;">
          <strong>${safe(purchaserName)}</strong> bought a ProFixter
          ${safe(plan)} gift membership for <strong>${safe(recipientName)}</strong>.
        </p>
        ${
          wasFullyDiscounted
            ? `<p style="margin:0 0 16px; padding:10px 14px; background:#FFF7E6; border-left:3px solid #D4A574; font-size:14px;">
                 <strong>Paid nothing.</strong> A promotion code covered the whole amount, so no
                 money was taken. The gift is valid and the recipient has been invited.
               </p>`
            : ""
        }
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse; margin:0 0 16px;">
          ${[
            ["Gift reference", safe(giftNumber)],
            ["Plan", `${safe(plan)} &middot; ${months(durationMonths)}`],
            ["Purchaser", `${safe(purchaserName)} (${safe(purchaserEmail)})`],
            ["Recipient", `${safe(recipientName)} (${safe(recipientEmail)})`],
            ...(recipientPhone ? [["Recipient phone", safe(recipientPhone)]] : []),
            ["Purchased", safe(purchasedAt)],
            ["Occasion", safe(occasion, "None")],
            ["Subtotal", safe(subtotal)],
            ["Discount", safe(discount)],
            ["Tax", safe(tax)],
            ["Paid", `<span style="font-size:16px;">${safe(amountPaid)}</span>`],
            ["Claim status", safe(claimStatus)],
          ]
            .map(
              ([k, v]) =>
                `<tr><td style="padding:6px 12px 6px 0; color:#6b7280; font-size:14px; white-space:nowrap;">${k}</td><td style="padding:6px 0; font-size:14px; color:#1f2937;"><strong>${v}</strong></td></tr>`
            )
            .join("")}
        </table>
        ${
          personalMessage
            ? `<p style="margin:0 0 6px; color:#6b7280; font-size:13px;">Message from the purchaser</p>
               <p style="margin:0 0 16px; padding:10px 14px; background:#F6F7F9; font-size:14px; font-style:italic;">
                 ${safe(personalMessage)}
               </p>`
            : ""
        }
        <p style="margin:0; color:#6b7280; font-size:14px;">
          The recipient has been sent their invitation. Nothing is needed from you.
        </p>
      `),
      text:
        `${purchaserName} bought a ProFixter ${plan} gift membership for ${recipientName}.\n\n` +
        `Gift reference: ${giftNumber}\n` +
        `Plan: ${plan} (${months(durationMonths)})\n` +
        `Purchaser: ${purchaserName} (${purchaserEmail})\n` +
        `Recipient: ${recipientName} (${recipientEmail})\n` +
        `Purchased: ${purchasedAt}\n` +
        `Occasion: ${occasion || "None"}\n` +
        `Subtotal: ${subtotal}\n` +
        `Discount: ${discount}\n` +
        `Tax: ${tax}\n` +
        `Paid: ${amountPaid}${wasFullyDiscounted ? " (fully covered by a promotion code)" : ""}\n` +
        `Claim status: ${claimStatus}\n` +
        (personalMessage ? `\nMessage: ${personalMessage}\n` : "") +
        `\nThe recipient has been sent their invitation.\n\n${SUPPORT_EMAIL}`,
    }),

    /*
     * The recipient claimed a gift and chose the property.
     *
     * Two shapes, because there are two genuinely different outcomes. Usually
     * the membership starts there and then. But if that address already has a
     * paid membership running, the gift waits behind it rather than being
     * spent on time the customer has already bought — and an admin reading
     * "claimed" would otherwise expect cover that has not begun.
     */
    gift_claimed_admin: ({
      giftNumber,
      purchaserName,
      purchaserEmail,
      recipientName,
      recipientEmail,
      recipientPhone,
      plan,
      durationMonths,
      claimedAt,
      propertyAddress,
      startsOn,
      endsOn,
      giftState,
      queued,
      activationNote,
    }) => ({
      subject: "Gift Membership Claimed - Profixter",
      html: shell(`
        <p style="margin:0 0 14px; font-size:17px;">
          <strong>${safe(recipientName)}</strong> claimed the ProFixter ${safe(plan)} gift
          membership from <strong>${safe(purchaserName)}</strong>.
        </p>
        ${
          queued
            ? `<p style="margin:0 0 16px; padding:10px 14px; background:#FFF7E6; border-left:3px solid #D4A574; font-size:14px;">
                 <strong>Gift claimed - activation pending existing paid coverage.</strong><br />
                 ${safe(activationNote)}
               </p>`
            : ""
        }
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse; margin:0 0 16px;">
          ${[
            ["Gift reference", safe(giftNumber)],
            ["Plan", `${safe(plan)} &middot; ${months(durationMonths)}`],
            ["Purchaser", `${safe(purchaserName)} (${safe(purchaserEmail)})`],
            ["Recipient", `${safe(recipientName)} (${safe(recipientEmail)})`],
            ...(recipientPhone ? [["Recipient phone", safe(recipientPhone)]] : []),
            ["Claimed", safe(claimedAt)],
            ["Property", safe(propertyAddress)],
            [queued ? "Begins" : "Started", safe(startsOn)],
            ["Ends", safe(endsOn)],
            ["State right now", safe(giftState)],
          ]
            .map(
              ([k, v]) =>
                `<tr><td style="padding:6px 12px 6px 0; color:#6b7280; font-size:14px; white-space:nowrap;">${k}</td><td style="padding:6px 0; font-size:14px; color:#1f2937;"><strong>${v}</strong></td></tr>`
            )
            .join("")}
        </table>
        <p style="margin:0; color:#6b7280; font-size:14px;">
          ${
            queued
              ? "No action needed. The gift starts on its own when the paid membership ends."
              : "The membership is live at that property now. Nothing is needed from you."
          }
        </p>
      `),
      text:
        `${recipientName} claimed the ProFixter ${plan} gift membership from ${purchaserName}.\n\n` +
        (queued
          ? `Gift claimed - activation pending existing paid coverage.\n${activationNote}\n\n`
          : "") +
        `Gift reference: ${giftNumber}\n` +
        `Plan: ${plan} (${months(durationMonths)})\n` +
        `Purchaser: ${purchaserName} (${purchaserEmail})\n` +
        `Recipient: ${recipientName} (${recipientEmail})\n` +
        `Claimed: ${claimedAt}\n` +
        `Property: ${propertyAddress}\n` +
        `${queued ? "Begins" : "Started"}: ${startsOn}\n` +
        `Ends: ${endsOn}\n` +
        `State right now: ${giftState}\n\n${SUPPORT_EMAIL}`,
    }),

    /*
     * Two weeks on and nobody has claimed it.
     *
     * Sent once per gift, ever. Counted from settlement rather than from
     * checkout creation, so an abandoned session that was later completed is
     * measured from the day the money actually moved.
     *
     * NO CLAIM TOKEN. The link is a credential that grants a stranger the
     * membership, and it belongs in exactly one inbox: the recipient's. The
     * admin gets the gift reference instead, which is what Admin searches on.
     */
    gift_unclaimed_admin: ({
      giftNumber,
      purchaserName,
      purchaserEmail,
      recipientName,
      recipientEmail,
      recipientPhone,
      plan,
      durationMonths,
      purchasedAt,
      daysUnclaimed,
      giftStatus,
      adminUrl,
      invitationExpired,
    }) => ({
      subject: "Gift Membership Still Unclaimed After 14 Days",
      html: shell(`
        <p style="margin:0 0 14px; font-size:17px;">
          A gift membership bought <strong>${safe(daysUnclaimed)} days ago</strong> has still not
          been claimed.
        </p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse; margin:0 0 16px;">
          ${[
            ["Gift reference", safe(giftNumber)],
            ["Plan", `${safe(plan)} &middot; ${months(durationMonths)}`],
            ["Purchaser", `${safe(purchaserName)} (${safe(purchaserEmail)})`],
            ["Recipient", `${safe(recipientName)} (${safe(recipientEmail)})`],
            ...(recipientPhone ? [["Recipient phone", safe(recipientPhone)]] : []),
            ["Invitation sent to", safe(recipientEmail)],
            ["Purchased", safe(purchasedAt)],
            ["Days unclaimed", safe(daysUnclaimed)],
            ["Status", safe(giftStatus)],
          ]
            .map(
              ([k, v]) =>
                `<tr><td style="padding:6px 12px 6px 0; color:#6b7280; font-size:14px; white-space:nowrap;">${k}</td><td style="padding:6px 0; font-size:14px; color:#1f2937;"><strong>${v}</strong></td></tr>`
            )
            .join("")}
        </table>
        ${
          invitationExpired
            ? `<p style="margin:0 0 14px; padding:10px 14px; background:#FDECEC; border-left:3px solid #D26A6A; font-size:14px;">
                 The invitation link has expired. Re-issue it from Admin to give them a working one.
               </p>`
            : `<p style="margin:0 0 14px; font-size:14px;">
                 The invitation link still works. The recipient may simply have missed the email.
               </p>`
        }
        ${adminUrl ? button(adminUrl, "Open in Admin") : ""}
        <p style="margin:14px 0 0; color:#6b7280; font-size:14px;">
          The gift is paid for and stays valid. This is a nudge to follow up, not a problem with
          the purchase. Search Admin for <strong>${safe(giftNumber)}</strong>.
        </p>
      `),
      text:
        `A gift membership bought ${daysUnclaimed} days ago has still not been claimed.\n\n` +
        `Gift reference: ${giftNumber}\n` +
        `Plan: ${plan} (${months(durationMonths)})\n` +
        `Purchaser: ${purchaserName} (${purchaserEmail})\n` +
        `Recipient: ${recipientName} (${recipientEmail})\n` +
        `Invitation sent to: ${recipientEmail}\n` +
        `Purchased: ${purchasedAt}\n` +
        `Days unclaimed: ${daysUnclaimed}\n` +
        `Status: ${giftStatus}\n\n` +
        (invitationExpired
          ? "The invitation link has expired. Re-issue it from Admin.\n\n"
          : "The invitation link still works; the recipient may have missed the email.\n\n") +
        `The gift is paid for and stays valid. Search Admin for ${giftNumber}.\n\n${SUPPORT_EMAIL}`,
    }),

    /*
     * A refund landed on a gift. EMAIL ONLY — SMS stays switched off until
     * Twilio is approved, and nothing about gifts may depend on it.
     *
     * Deliberately does NOT say the entitlement was revoked, because it was
     * not. A refund can be a partial goodwill gesture, a duplicate-charge
     * correction, or a chargeback we intend to contest, so the money is
     * reconciled automatically and the decision about access is left to a
     * person. This message is what tells that person there is a decision to
     * make.
     */
    gift_refunded_admin: ({
      giftNumber,
      purchaserName,
      purchaserEmail,
      recipientName,
      recipientEmail,
      recipientPhone,
      plan,
      durationMonths,
      refundAmount,
      refundedTotal,
      amountPaid,
      refundStatus,
      giftState,
    }) => ({
      subject: `Gift refund (${safe(refundStatus)}) - ${safe(giftNumber)}`,
      html: shell(`
        <p style="margin:0 0 14px; font-size:17px;">
          A <strong>${safe(refundStatus)}</strong> refund was recorded against a gift membership.
        </p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse; margin:0 0 16px;">
          ${[
            ["Gift reference", safe(giftNumber)],
            ["Plan", `${safe(plan)} &middot; ${months(durationMonths)}`],
            ["Purchaser", `${safe(purchaserName)} (${safe(purchaserEmail)})`],
            ["Recipient", `${safe(recipientName)} (${safe(recipientEmail)})`],
            ...(recipientPhone ? [["Recipient phone", safe(recipientPhone)]] : []),
            ["This refund", safe(refundAmount)],
            ["Refunded in total", `${safe(refundedTotal)} of ${safe(amountPaid)}`],
            ["Refund status", safe(refundStatus)],
            ["Gift access right now", safe(giftState)],
          ]
            .map(
              ([k, v]) =>
                `<tr><td style="padding:6px 12px 6px 0; color:#6b7280; font-size:14px; white-space:nowrap;">${k}</td><td style="padding:6px 0; font-size:14px; color:#1f2937;"><strong>${v}</strong></td></tr>`
            )
            .join("")}
        </table>
        <p style="margin:0 0 10px; font-size:14px;">
          <strong>The gift has NOT been revoked.</strong> Access is unchanged and the recipient can
          still use whatever coverage remains.
        </p>
        <p style="margin:0; color:#6b7280; font-size:14px;">
          If it should be withdrawn, cancel the gift in Admin. That is a deliberate step so a
          disputed or partial refund cannot silently end a membership somebody is using.
        </p>
      `),
      text:
        `A ${refundStatus} refund was recorded against gift ${giftNumber}.\n\n` +
        `Plan: ${plan} (${months(durationMonths)})\n` +
        `Purchaser: ${purchaserName} (${purchaserEmail})\n` +
        `Recipient: ${recipientName} (${recipientEmail})\n` +
        `This refund: ${refundAmount}\n` +
        `Refunded in total: ${refundedTotal} of ${amountPaid}\n` +
        `Gift access right now: ${giftState}\n\n` +
        `The gift has NOT been revoked. Cancel it in Admin if it should be withdrawn.\n\n` +
        `${SUPPORT_EMAIL}`,
    }),

    /* ------------------------------ Recipient ---------------------------- */
    gift_invitation: ({
      name = "there",
      from,
      plan,
      durationMonths,
      claimUrl,
      occasion,
      personalMessage,
    }) => {
      const copy = occasionCopy(occasion);
      return {
        subject: `${safe(from)} sent you ${months(durationMonths)} of ProFixter ${safe(plan)}`,
        html: shell(`
        <p style="margin:0 0 20px; text-align:center; font-family:Arial,Helvetica,sans-serif; font-size:16px; color:#4b5563;">
          <strong>${safe(from)}</strong> sent you a gift.
        </p>
        ${giftCardBlock({
          occasion,
          plan,
          durationMonths,
          from,
          toName: name,
          message: personalMessage,
        })}
        ${giftButton(claimUrl, "Open your gift")}
        <p style="margin:14px 0 0; text-align:center; font-family:Arial,Helvetica,sans-serif; font-size:14px; color:#6b7280;">
          There is nothing to pay and no card to enter.
        </p>
        <p style="margin:10px 0 0; text-align:center; font-family:Arial,Helvetica,sans-serif; font-size:14px; color:#6b7280;">
          Your ${months(durationMonths)} start when you claim, not today &mdash; so you lose
          nothing by claiming when it suits you.
        </p>
      `),
        text:
          `${copy.title}\n\n${from} sent you ${months(durationMonths)} of ProFixter ${plan}.\n\n` +
          (personalMessage ? `"${personalMessage}"\n\n` : "") +
          `There is nothing to pay and no card to enter.\n\nOpen your gift: ${claimUrl}\n\n` +
          `Your ${months(durationMonths)} start when you claim, not today.\n\n${SUPPORT_EMAIL}`,
      };
    },

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
