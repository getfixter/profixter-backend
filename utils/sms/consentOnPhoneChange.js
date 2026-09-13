const { normalizePhoneE164 } = require("../identity");

/**
 * What happens to SMS consent when a customer's phone number is edited.
 *
 * CONSENT BELONGS TO THE NUMBER, NOT TO THE ACCOUNT.
 *
 * Somebody ticked "text me about my visits" about the handset in their hand.
 * Point the account at a different number and that tick becomes evidence about
 * a phone we no longer dial: the new number never agreed to anything, and
 * nobody at it was ever asked. Carrying the flags across would make the new
 * number eligible purely because its predecessor consented - the same defect as
 * inferring consent from the presence of a phone field, which is what error
 * 30923 was about, only harder to catch because the record still looks like a
 * genuine opt-in.
 *
 * WHAT COUNTS AS A CHANGE
 *
 * The number, not the typing. "(631) 555-0147", "631-555-0147" and
 * "+16315550147" are one phone, and an admin tidying up how it is written must
 * not silently unsubscribe a customer. Both sides are normalised to E.164
 * before they are compared, so only a genuinely different destination resets
 * anything. That asymmetry is deliberate: wrongly keeping consent is a
 * compliance failure, wrongly destroying it is a customer annoyance, and the
 * rule is built so that neither happens for a cosmetic edit.
 *
 * WHAT IS CLEARED, AND WHAT IS KEPT
 *
 * Only the two eligibility flags are cleared, and they are UNSET rather than
 * set to false. The model keeps "never asked" and "asked and declined" as
 * different states on purpose, and for a number nobody has ever put the
 * question to, absent is the honest one.
 *
 * The timestamps and sources are left exactly as they are. They record that
 * this account did consent, when, and through which surface. All of that stays
 * true after the number changes, and it is the evidence trail somebody will
 * want if the consent is ever questioned - so nothing here destroys it.
 *
 * Clearing the phone entirely counts as a change: there is no destination left
 * that anyone consented to.
 */
function consentResetForPhoneChange({ previousPhone, nextPhone, smsPreferences } = {}) {
  const previous = normalizePhoneE164(String(previousPhone || "").trim()) || "";
  const next = normalizePhoneE164(String(nextPhone || "").trim()) || "";

  const prefs = smsPreferences || {};
  const clearedTransactional = prefs.transactionalEnabled === true;
  const clearedMarketing = prefs.marketingEnabled === true;

  /*
   * Nothing to withdraw. An account with no affirmative consent is already
   * ineligible, and rewriting its record on an unrelated edit would only add
   * noise to the audit trail.
   */
  if (!clearedTransactional && !clearedMarketing) {
    return { reset: false, unset: {}, clearedTransactional: false, clearedMarketing: false, previous, next };
  }

  if (previous === next) {
    return { reset: false, unset: {}, clearedTransactional: false, clearedMarketing: false, previous, next };
  }

  return {
    reset: true,
    unset: {
      "smsPreferences.transactionalEnabled": "",
      "smsPreferences.marketingEnabled": "",
    },
    clearedTransactional,
    clearedMarketing,
    previous,
    next,
  };
}

module.exports = { consentResetForPhoneChange };
