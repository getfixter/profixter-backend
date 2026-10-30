const crypto = require("crypto");
const AdminPaymentLink = require("../../models/AdminPaymentLink");
const mail = require("../emailService");
const { sendTransactionalSms } = require("../sms/smsService");

/**
 * Admin payment links: create, send, look up, close.
 *
 * profixter.com/pay/<token>. The token is 16 random bytes (base64url, 22
 * characters) and only its SHA-256 is stored, so a database read never yields a
 * working link. What the link may do is decided when it is USED, by
 * routes/pay.js - this module only makes and delivers it.
 */

const SITE = "https://www.profixter.com";
const MEMBERSHIP_LINK_DAYS = 7;

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function newToken() {
  return crypto.randomBytes(16).toString("base64url");
}

function payUrlFor(token) {
  return `${SITE}/pay/${token}`;
}

async function findLinkByToken(token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ""))) return null;
  return AdminPaymentLink.findOne({ tokenHash: hashToken(token) });
}

/** Expired by date, whatever its stored status says. */
function linkIsLive(link, now = new Date()) {
  return Boolean(link) && link.status === "open" && new Date(link.expiresAt).getTime() > now.getTime();
}

function firstNameOf(name) {
  const first = String(name || "").trim().split(/\s+/)[0] || "";
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "there";
}

function renderLinkEmail({ name, itemLabel, payUrl, expiresAt }) {
  const e = mail.escapeHtml;
  const p = (t) => `<p style="margin:0 0 16px;">${t}</p>`;
  const until = new Date(expiresAt).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const html = mail.frame(
    `${p(`Hi ${e(firstNameOf(name))},`)}
     ${p(`Here is your secure payment link for <strong>${e(itemLabel)}</strong>, as we discussed on the phone.`)}
     ${mail.btn(payUrl, "Pay securely")}
     ${p(`Payment is processed by Stripe. This link works until ${e(until)} (New York time).`)}
     <p style="margin:20px 0 0;">The Profixter Team<br/><a href="https://www.profixter.com">https://www.profixter.com</a></p>`,
    { preheader: `Your secure payment link for ${itemLabel}.` }
  );
  const text = [
    `Hi ${firstNameOf(name)},`,
    `Here is your secure payment link for ${itemLabel}, as we discussed on the phone.`,
    `Pay securely: ${payUrl}`,
    `Payment is processed by Stripe. This link works until ${until} (New York time).`,
    "The Profixter Team\nhttps://www.profixter.com",
  ].join("\n\n");
  return { subject: `Your Profixter payment link: ${itemLabel}`, html, text };
}

/**
 * Make the link (nothing is sent yet). `contact` is { name, email, phone,
 * user, booking } - user for an account, booking for a visit (a guest visit
 * has only booking). Returns { link, token, payUrl }.
 */
async function createLink({ kind, contact, itemLabel, channels = ["email", "sms"], expiresAt = null, plan = "", billingCycle = "", addressId = null, admin = null }) {
  const token = newToken();
  const wantEmail = channels.includes("email") && Boolean(contact.email);
  const wantSms = channels.includes("sms") && Boolean(contact.phone);
  const link = await AdminPaymentLink.create({
    tokenHash: hashToken(token),
    kind,
    user: contact.user?._id || null,
    addressId,
    plan,
    billingCycle,
    booking: contact.booking?._id || null,
    itemLabel,
    expiresAt: expiresAt || new Date(Date.now() + MEMBERSHIP_LINK_DAYS * 24 * 60 * 60 * 1000),
    sentVia: [wantEmail ? "email" : null, wantSms ? "sms" : null].filter(Boolean),
    sentTo: { email: wantEmail ? String(contact.email) : "", phone: wantSms ? String(contact.phone) : "" },
    createdBy: admin?._id || null,
    createdByName: String(admin?.name || admin?.email || "").slice(0, 120),
  });
  return { link, token, payUrl: payUrlFor(token) };
}

/** Send a link by the channels chosen when it was made. Once per link (SMS dedupe on its id). */
async function sendLink({ link, payUrl, contact, deps = {} }) {
  const sendEmail = deps.sendRaw || mail.sendRaw;
  const sendSms = deps.sendTransactionalSms || sendTransactionalSms;
  const wantEmail = link.sentVia.includes("email");
  const wantSms = link.sentVia.includes("sms");
  const itemLabel = link.itemLabel;

  const delivery = { email: wantEmail ? "" : "not_requested", sms: wantSms ? "" : "not_requested" };
  if (wantEmail) {
    try {
      const { subject, html, text } = renderLinkEmail({ name: contact.name, itemLabel, payUrl, expiresAt: link.expiresAt });
      await sendEmail({
        to: link.sentTo.email,
        subject,
        html,
        text,
        bccAdmin: false,
        logContext: {
          templateKey: "payment_link",
          userId: contact.user?._id || null,
          bookingId: contact.booking?._id || null,
          bookingNumber: contact.booking?.bookingNumber || "",
          customerName: contact.name || "",
          customerEmail: link.sentTo.email,
          recipientName: contact.name || "",
          recipientEmail: link.sentTo.email,
          emailType: "billing",
          source: "adminPaymentLink",
        },
      });
      delivery.email = "sent";
    } catch (error) {
      delivery.email = `failed: ${String(error?.message || error).slice(0, 120)}`;
    }
  }
  if (wantSms) {
    try {
      const result = await sendSms({
        notificationType: "PAYMENT_LINK",
        dedupeKey: `PAYMENT_LINK:${link._id}`,
        user: contact.user || null,
        phone: link.sentTo.phone,
        booking: contact.booking || null,
        vars: { itemLabel, payUrl },
        source: "adminPaymentLink",
      });
      delivery.sms = String(result?.status || "unknown") + (result?.reason ? `:${result.reason}` : "");
    } catch (error) {
      delivery.sms = `failed: ${String(error?.message || error).slice(0, 120)}`;
    }
  }
  await AdminPaymentLink.updateOne({ _id: link._id }, { $set: { delivery } });
  link.delivery = delivery;
  return delivery;
}

async function createAndSendLink(args) {
  const { link, token, payUrl } = await createLink(args);
  const delivery = await sendLink({ link, payUrl, contact: args.contact, deps: args.deps || {} });
  return { link, token, payUrl, delivery };
}

/** Stripe says a checkout opened from a link was paid: close the link. */
async function markLinkPaidFromSession(session) {
  const id = session?.metadata?.adminPaymentLinkId;
  if (!id || !/^[a-f0-9]{24}$/i.test(String(id))) return null;
  return AdminPaymentLink.findOneAndUpdate(
    { _id: id, status: { $ne: "paid" } },
    { $set: { status: "paid", paidAt: new Date(), lastSessionId: String(session.id || "") } },
    { new: true }
  );
}

module.exports = {
  MEMBERSHIP_LINK_DAYS,
  createAndSendLink,
  createLink,
  sendLink,
  findLinkByToken,
  hashToken,
  linkIsLive,
  markLinkPaidFromSession,
  payUrlFor,
  renderLinkEmail,
};
