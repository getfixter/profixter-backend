/**
 * Agents never send, publish or mail anything themselves: messages go out
 * only when the growth engine executes an approved action, and that leaves a
 * GrowthAction record with status "succeeded". So when a summary says "I
 * sent…" (or emailed, texted, published…) and the shift has no succeeded
 * sending action behind it, the claim is false - typically a DRAFT described
 * as sent. That once reached the owner ("I sent the cancellation message" for
 * a draft) and was repeated by King Arthur.
 *
 * correctSendClaims rewrites such first-person claims in place to say what
 * really happened ("I drafted (not sent)…") and reports whether it did.
 * It is applied when a run is saved (runtime) and again whenever an old run
 * is shown or handed to Arthur, so history recorded before this fix is
 * corrected too. Text about what OTHER parts of the system did ("12 reminders
 * were sent last week") is data and is left alone.
 */
const SEND_TYPES = ["conversation_reply", "playbook_email", "checkout_recovery_email", "post_free_visit_sms"];

const CLAIM_RE = /\b(I|we)((?:['’]ve)?(?:\s+(?:have|just|already|also|then|now|successfully))*)\s+(sent|emailed|e-mailed|texted|messaged|mailed|delivered|published|posted)\b/gi;

/** { text, corrected } - corrected is true when a false claim was rewritten. */
function correctSendClaims(text, { sentCount = 0 } = {}) {
  const t = String(text ?? "");
  if (!t || sentCount > 0) return { text: t, corrected: false };
  let corrected = false;
  // "I sent the message" -> "I drafted (not sent) the message"
  const out = t.replace(CLAIM_RE, (_m, who, _adv, verb) => {
    corrected = true;
    return `${who} drafted (not ${verb.toLowerCase()})`;
  });
  return { text: out, corrected };
}

/** How many sending actions linked to a run actually succeeded (the delivery record). */
async function sentCountForRun(run) {
  const ids = run?.actions || [];
  if (!ids.length) return 0;
  const GrowthAction = require("../../models/GrowthAction");
  return GrowthAction.countDocuments({ _id: { $in: ids }, type: { $in: SEND_TYPES }, status: "succeeded" });
}

/** A run's two summaries, corrected (sync; for runs from agents, which never send themselves). */
function correctedRun(run) {
  return {
    summary: correctSendClaims(run?.summary).text,
    plainSummary: correctSendClaims(run?.plainSummary).text,
  };
}

module.exports = { SEND_TYPES, correctSendClaims, correctedRun, sentCountForRun };
