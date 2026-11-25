const CommMessage = require("../../models/CommMessage");
const { CommPendingStatus } = require("../../models/Comms");
const { applyToConversation } = require("./core");

/**
 * Delivery status for texts, in one place.
 *
 * Twilio does not promise callbacks arrive in order, and retries them, so a
 * status only ever moves FORWARD by rank: "delivered" is never overwritten by a
 * late "sent". A status that arrives before the send that caused it has been
 * saved (the callback can beat our own database write) is parked in
 * CommPendingStatus and applied the moment the SID is recorded.
 *
 * Accepted by Twilio ("sent") is not delivered. Only "delivered" means a
 * carrier confirmed the handset received it, and the inbox says so.
 */
const RANK = {
  logged: 0,
  scheduled: 1,
  queued: 1,
  accepted: 1,
  unknown: 2,
  sending: 2,
  sent: 3,
  received: 4,
  suppressed: 5,
  canceled: 5,
  delivered: 6,
  undelivered: 6,
  failed: 6,
  read: 7,
};

/** Twilio's word for the state, mapped to ours. */
const FROM_TWILIO = {
  accepted: "queued",
  scheduled: "scheduled",
  queued: "queued",
  sending: "sending",
  sent: "sent",
  delivered: "delivered",
  undelivered: "undelivered",
  failed: "failed",
  read: "read",
  canceled: "canceled",
  receiving: "received",
  received: "received",
};

const rankOf = (s) => RANK[s] ?? 0;

/**
 * Apply a provider status to the message with this SID. Returns the updated
 * message, or null when no message has this SID yet (then it is parked).
 */
async function applyProviderStatus(sid, rawStatus, { errorCode = "", errorMessage = "", park = true } = {}) {
  const status = FROM_TWILIO[String(rawStatus || "").toLowerCase()];
  if (!sid || !status) return null;
  const rank = rankOf(status);
  const set = { status, statusRank: rank, providerStatus: String(rawStatus).toLowerCase() };
  if (errorCode) set.errorCode = String(errorCode).slice(0, 20);
  if (errorMessage) set.errorMessage = String(errorMessage).slice(0, 300);
  if (status === "delivered") set.deliveredAt = new Date();
  const updated = await CommMessage.findOneAndUpdate(
    { provider: "twilio", providerId: sid, statusRank: { $lt: rank } },
    { $set: set },
    { new: true }
  );
  if (updated) {
    await applyToConversation(updated, { countUnread: false }).catch(() => {});
    if (updated.bulkRecipient) await syncBulkRecipient(updated);
    return updated;
  }
  const exists = await CommMessage.exists({ provider: "twilio", providerId: sid });
  if (!exists && park) await CommPendingStatus.create({ sid, status: String(rawStatus).toLowerCase(), errorCode: String(errorCode || "") });
  return null;
}

/** A bulk recipient's outcome follows its message's delivery status. */
const RECIPIENT_FROM_MESSAGE = { queued: "sent", sending: "sent", sent: "sent", delivered: "delivered", undelivered: "undelivered", failed: "failed", unknown: "unknown" };
async function syncBulkRecipient(message) {
  const status = RECIPIENT_FROM_MESSAGE[message.status];
  if (!status || !message.bulkRecipient) return;
  const { CommBulkRecipient } = require("../../models/Comms");
  await CommBulkRecipient.updateOne({ _id: message.bulkRecipient, status: { $nin: ["delivered"] } }, { $set: { status, reason: message.errorMessage || "" } });
}

/** After a SID is saved: apply any status that arrived first. */
async function drainPending(sid) {
  if (!sid) return;
  const rows = await CommPendingStatus.find({ sid }).sort({ at: 1 }).lean();
  for (const r of rows) await applyProviderStatus(sid, r.status, { errorCode: r.errorCode, park: false });
  if (rows.length) await CommPendingStatus.deleteMany({ sid });
}

const isConfirmedFailure = (status) => status === "failed" || status === "undelivered";

module.exports = { FROM_TWILIO, RANK, applyProviderStatus, drainPending, isConfirmedFailure, rankOf, syncBulkRecipient };
