/**
 * Which document statuses can still be executed by a customer signature.
 *
 * Kept dependency-free (no S3, no models) so read-only code such as the
 * Needs-action collectors can share the exact rule the signing service
 * enforces without loading the storage client.
 */

/**
 * Change Order statuses in which a customer signature may still execute it.
 * Draft is excluded because nothing unissued can be signed; the locked states
 * (Executed, Declined, Voided) are excluded because the owner closed them.
 */
const SIGNABLE_CHANGE_ORDER_STATUSES = Object.freeze([
  "Ready to Send",
  "Sent",
  "Viewed",
  "Awaiting Signature",
  "Partially Signed",
]);

/** Agreement statuses in which a customer signature may still execute it. */
const SIGNABLE_CONTRACT_STATUSES = Object.freeze(["Generated", "Emailed"]);

module.exports = { SIGNABLE_CHANGE_ORDER_STATUSES, SIGNABLE_CONTRACT_STATUSES };
