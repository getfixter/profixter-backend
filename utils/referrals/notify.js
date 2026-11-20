/**
 * Who hears what, once.
 *
 * Each notice is claimed with a conditional update on its `notified.*` time
 * before it is sent, so two webhook deliveries racing each other send it once.
 * The owner's Admin notice is the Needs action list (collectors/referralRewards)
 * and the Referrals section; the email below is the nudge to open it.
 * Nothing here ever throws.
 */
const User = require("../../models/User");
const { CustomerReferral } = require("../../models/ReferralProgram");
const { dollars } = require("./amounts");

const PLAN_LABEL = { basic: "Basic", plus: "Plus", premium: "Premium", elite: "Elite" };
const ownerEmail = () => String(process.env.MAIL_ADMIN || "getfixter@gmail.com").toLowerCase();
const adminUrl = (id) => `${String(process.env.CLIENT_URL || "https://www.profixter.com").replace(/\/+$/, "")}/admin/referrals${id ? `/${id}` : ""}`;

function log(event, details) {
  console.log(JSON.stringify({ at: new Date().toISOString(), area: "referrals", event, ...details }));
}

/** "Maria K." - what the referrer is told about the friend they brought. */
function friendLabel(user) {
  if (!user) return "Your friend";
  const first = String(user.firstName || String(user.name || "").split(/\s+/)[0] || "").trim();
  const last = String(user.lastName || String(user.name || "").split(/\s+/).slice(1).join(" ") || "").trim();
  if (!first) return "Your friend";
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

async function claim(id, field) {
  const r = await CustomerReferral.updateOne({ _id: id, [`notified.${field}`]: null }, { $set: { [`notified.${field}`]: new Date() } });
  return r.modifiedCount === 1;
}

async function mailReferrer(doc, field, key, vars) {
  try {
    if (field && !(await claim(doc._id, field))) return null;
    const referrer = await User.findById(doc.referrer).select("email name firstName emailIsAppleRelay").lean();
    if (!referrer?.email) return null;
    const mail = require("../emailService");
    return await mail.sendTx(key, referrer.email, { name: referrer.firstName || String(referrer.name || "").split(" ")[0] || "there", ...vars }, {
      bccAdmin: false,
      logContext: { userId: referrer._id, recipientEmail: referrer.email, emailType: "referral", source: "referralProgram" },
    });
  } catch (error) {
    log("referrer_mail_failed", { key, message: String(error?.message || error).slice(0, 160) });
    return null;
  }
}

async function friendOf(doc) {
  return friendLabel(await User.findById(doc.referred).select("name firstName lastName").lean());
}

async function referrerPending(doc) {
  return mailReferrer(doc, "referrerPendingAt", "referral_reward_pending", {
    friend: await friendOf(doc),
    amount: dollars(doc.amountCents),
    plan: PLAN_LABEL[doc.first?.plan] || "",
  });
}

async function referrerReady(doc) {
  return mailReferrer(doc, "referrerReadyAt", "referral_reward_ready", { friend: await friendOf(doc), amount: dollars(doc.amountCents) });
}

async function referrerMailed(doc) {
  return mailReferrer(doc, null, "referral_reward_mailed", {
    amount: dollars(doc.approval?.amountCents || doc.amountCents),
    reference: doc.check?.reference || "",
    mailedOn: doc.check?.mailedAt ? new Date(doc.check.mailedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" }) : "",
  });
}

async function referrerPayeeSaved(doc) {
  const p = doc.payee || {};
  return mailReferrer(doc, null, "referral_payee_saved", {
    payee: p.name || "",
    address: [p.line1, p.line2, `${p.city || ""}, ${p.state || ""} ${p.zip || ""}`.trim()].filter(Boolean).join(", "),
  });
}

async function mailOwner(subject, lines, id) {
  try {
    const mail = require("../emailService");
    const html = `${lines.map((l) => `<p>${mail.escapeHtml(l)}</p>`).join("")}<p><a href="${adminUrl(id)}">Open Referrals in Admin</a></p>`;
    return await mail.sendPromo(ownerEmail(), {
      subject,
      html,
      logContext: { templateKey: "admin_referral_reward", recipientEmail: ownerEmail(), emailType: "admin", source: "referralProgram" },
    });
  } catch (error) {
    log("owner_mail_failed", { message: String(error?.message || error).slice(0, 160) });
    return null;
  }
}

async function names(doc) {
  const [referrer, referred] = await Promise.all([
    User.findById(doc.referrer).select("name").lean(),
    User.findById(doc.referred).select("name").lean(),
  ]);
  return { referrer: referrer?.name || "A customer", referred: referred?.name || "their friend" };
}

async function ownerReady(doc) {
  try {
    if (!(await claim(doc._id, "ownerReadyAt"))) return null;
    const n = await names(doc);
    const flags = (doc.flags || []).filter((f) => f.strength !== "info");
    return mailOwner(
      `Referral reward ready: ${dollars(doc.amountCents)} for ${n.referrer}`,
      [
        `${n.referrer} referred ${n.referred}, whose second membership payment has cleared. The reward is ${dollars(doc.amountCents)}.`,
        flags.length ? `${flags.length} flag${flags.length === 1 ? "" : "s"} to review: ${flags.map((f) => f.text).join(" ")}` : "No flags.",
        "Approve it in Admin once the payee and mailing address are confirmed. Stripe is checked again before you approve and before you mark the check mailed.",
      ],
      String(doc._id)
    );
  } catch (error) {
    log("owner_ready_failed", { message: String(error?.message || error).slice(0, 160) });
    return null;
  }
}

async function ownerAttention(doc, text) {
  try {
    const n = await names(doc);
    await CustomerReferral.updateOne({ _id: doc._id }, { $set: { "notified.ownerAttentionAt": new Date() } });
    return mailOwner(`Referral reward needs a look: ${n.referrer}`, [`${n.referrer} referred ${n.referred}.`, text], String(doc._id));
  } catch (error) {
    log("owner_attention_failed", { message: String(error?.message || error).slice(0, 160) });
    return null;
  }
}

module.exports = { friendLabel, referrerPending, referrerReady, referrerMailed, referrerPayeeSaved, ownerReady, ownerAttention, PLAN_LABEL };
