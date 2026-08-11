/**
 * Electronic record and signature disclosure.
 *
 * Structured to cover each item 15 U.S.C. 7001(c)(1) requires a consumer to be
 * told BEFORE consenting:
 *   (A)(i)   right to a paper copy, and the right to withdraw consent
 *            including conditions, consequences and fees
 *   (A)(ii)  whether consent covers this transaction or wider categories
 *   (A)(iii) how to withdraw consent and how to update contact information
 *   (A)(iv)  how to obtain a paper copy after consenting, and any fee
 *   (C)      the hardware and software needed to access and retain the record
 *
 * The text is versioned. The version is written into the audit record at the
 * moment of consent, so what a signer agreed to can be reproduced exactly even
 * after this file changes. CHANGING ANY WORDING BELOW REQUIRES A NEW VERSION -
 * never edit text in place under an existing version.
 *
 * Written for a homeowner to actually read. Nothing required by the statute has
 * been dropped for brevity.
 *
 * ATTORNEY REVIEW: this is operating text drafted against the federal statute.
 * It has not been reviewed by a New York construction or consumer attorney, and
 * the interaction between electronic delivery and the NY home improvement
 * cancellation notice is specifically unresolved. See ATTORNEY_REVIEW_NOTES.
 */

const { COMPANY_INFO } = require("./premiumIslandHomesContract");

const DISCLOSURE_VERSION = "PIH-ESIGN-DISCLOSURE-2026-001";

/** Shown in full, above the consent control, before any signature is captured. */
const DISCLOSURE_SECTIONS = Object.freeze([
  {
    title: "Signing electronically",
    body:
      "You are about to sign this document electronically. An electronic signature has the same " +
      "legal effect as signing on paper. You do not have to sign electronically - see " +
      '"If you would rather not sign electronically" below.',
  },
  {
    title: "What this consent covers",
    body:
      "Your consent applies to this document only - the specific agreement or change order shown " +
      "on this page. It does not cover any other document, and it does not sign you up for " +
      "electronic delivery of anything else. If we send you another document later, you will be " +
      "asked again.",
  },
  {
    title: "Getting a paper copy",
    body:
      `You may ask ${COMPANY_INFO.legalName} for a paper copy of this document at any time, before ` +
      `or after signing, at no charge. Call ${COMPANY_INFO.phone} or email ${COMPANY_INFO.email} and ` +
      "we will mail one to the address on the agreement. You can also download and print the PDF " +
      "from this page at any point before you sign, and from the copy we email you afterwards.",
  },
  {
    title: "If you would rather not sign electronically",
    body:
      "You can withdraw your consent at any time before you sign, simply by closing this page and " +
      `contacting us at ${COMPANY_INFO.phone}. There is no fee and no penalty. We will arrange for ` +
      "you to sign a paper copy instead. The only consequence is that signing will take longer, " +
      "because the document has to be printed, delivered and returned.",
  },
  {
    title: "After you sign",
    body:
      "Once you sign, this consent has done its job for this document and cannot be withdrawn - " +
      "the signature is already part of the completed record. Withdrawing consent does not cancel " +
      "a signed agreement, and it does not affect any cancellation rights you have under New York " +
      "law, which are described in the agreement itself. To change or end a signed agreement, " +
      "contact us directly.",
  },
  {
    title: "Keeping your contact details current",
    body:
      `If your email address or mailing address changes, tell us at ${COMPANY_INFO.email} or ` +
      `${COMPANY_INFO.phone} so we can keep sending your documents to the right place.`,
  },
  {
    title: "What you need to sign and keep a copy",
    body:
      "To sign and to keep your own copy, you need: a device with an up-to-date web browser " +
      "(such as Safari, Chrome, Edge or Firefox); an internet connection; a screen you can read " +
      "the document on; a way to sign - a finger or stylus on a touchscreen, or a mouse or " +
      "trackpad; software that opens PDF files, which most phones, tablets and computers already " +
      "have; and either enough storage to save the PDF or a printer. You will also need a working " +
      "email address to receive your signed copy.",
  },
]);

/**
 * The consent control. Deliberately a single unchecked box: 7001(c)(1)(B)
 * requires consent to be affirmative, so it is never pre-checked and never
 * implied by continuing.
 */
const CONSENT_CHECKBOX_LABEL =
  "I have read the information above. I agree to use electronic records and an electronic " +
  "signature for this document, and I confirm I can open and read the PDF on this device.";

/**
 * The final action. Separate from consent on purpose: consent is agreeing to
 * the method, this is the act of signing. Both are recorded independently.
 */
const SIGN_INTENT_TEXT =
  "By selecting Sign Agreement, I am signing this document. I have reviewed it in full, I intend " +
  "my electronic signature to be my signature on it, and I understand it is legally binding once " +
  "both parties have signed.";

const SIGN_INTENT_TEXT_CHANGE_ORDER =
  "By selecting Sign Change Order, I am signing this document. I have reviewed it in full, I " +
  "intend my electronic signature to be my signature on it, and I understand it changes the " +
  "agreement it refers to once both parties have signed.";

/** Shown next to the signature pad so the act is unambiguous. */
const SIGNATURE_PAD_INSTRUCTION = "Draw your signature below using your finger, a stylus, or your mouse.";

/**
 * Unresolved questions that engineering must not answer on its own.
 * Surfaced here rather than buried in a commit message.
 */
const ATTORNEY_REVIEW_NOTES = Object.freeze([
  "Whether the generated agreement satisfies every content requirement of NY GBL 771, which " +
    "provides that a non-compliant home improvement contract may be void.",
  "How the New York home improvement cancellation notice must be delivered and acknowledged when " +
    "the agreement is signed electronically, and whether the cancellation period runs from " +
    "electronic delivery.",
  "Whether applying the company signature in advance satisfies GBL 771's requirement that a home " +
    "improvement contract and all amendments be signed by all the parties.",
  "Whether this disclosure is sufficient for a residential home improvement transaction in New " +
    "York, and whether any state-specific consumer disclosure must accompany it.",
  "Whether change orders require their own separate cancellation notice.",
]);

module.exports = {
  DISCLOSURE_VERSION,
  DISCLOSURE_SECTIONS,
  CONSENT_CHECKBOX_LABEL,
  SIGN_INTENT_TEXT,
  SIGN_INTENT_TEXT_CHANGE_ORDER,
  SIGNATURE_PAD_INSTRUCTION,
  ATTORNEY_REVIEW_NOTES,
};
