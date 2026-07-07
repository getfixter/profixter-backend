const crypto = require("crypto");
const { normalizePhoneE164 } = require("../../../utils/identity");

function cleanString(value) {
  return String(value || "").trim();
}

function getAtPath(source, path) {
  return path.split(".").reduce((current, part) => {
    if (current === undefined || current === null) return undefined;
    if (Array.isArray(current) && /^\d+$/.test(part)) return current[Number(part)];
    return current[part];
  }, source);
}

function firstString(source, paths) {
  for (const path of paths) {
    const value = getAtPath(source, path);
    if (typeof value === "string" || typeof value === "number") {
      const cleaned = cleanString(value);
      if (cleaned) return cleaned;
    }
  }
  return "";
}

function compactName(payload) {
  const name = firstString(payload, [
    "contactName",
    "name",
    "fullName",
    "contact.name",
    "contact.fullName",
    "contact.full_name",
    "customer.name",
    "customer.fullName",
  ]);
  if (name) return name;

  const first = firstString(payload, [
    "firstName",
    "first_name",
    "contact.firstName",
    "contact.first_name",
    "customer.firstName",
  ]);
  const last = firstString(payload, [
    "lastName",
    "last_name",
    "contact.lastName",
    "contact.last_name",
    "customer.lastName",
  ]);
  return [first, last].filter(Boolean).join(" ").trim();
}

function parseInboundGhlMessage(payload = {}) {
  const source = payload && typeof payload === "object" ? payload : {};
  const incomingMessage = firstString(source, [
    "incomingMessage",
    "message",
    "body",
    "text",
    "message.body",
    "message.text",
    "message.message",
    "message.content",
    "conversation.message",
    "conversation.lastMessageBody",
    "messages.0.body",
    "messages.0.text",
    "customData.incomingMessage",
  ]);
  const rawPhone = firstString(source, [
    "phone",
    "phoneNumber",
    "contact.phone",
    "contact.phoneNumber",
    "customer.phone",
    "from",
    "message.from",
    "message.phone",
    "conversation.contactPhone",
    "customData.phone",
  ]);

  const direction = firstString(source, [
    "direction",
    "message.direction",
    "messageDirection",
    "type",
  ]).toLowerCase();

  return {
    contactId: firstString(source, [
      "contactId",
      "contact_id",
      "contact.id",
      "contact._id",
      "customer.contactId",
      "message.contactId",
      "conversation.contactId",
      "customData.contactId",
      "customData.contact_id",
    ]),
    phone: normalizePhoneE164(rawPhone) || cleanString(rawPhone),
    name: compactName(source),
    incomingMessage,
    conversationId: firstString(source, [
      "conversationId",
      "conversation_id",
      "conversation.id",
      "message.conversationId",
      "customData.conversationId",
    ]),
    messageId: firstString(source, [
      "messageId",
      "message_id",
      "message.id",
      "messages.0.id",
      "id",
    ]),
    direction,
    isLikelyOutbound:
      direction.includes("outbound") ||
      direction === "sent" ||
      direction === "outgoing",
  };
}

function sanitizeForLog(value, depth = 0) {
  if (depth > 4) return "[MaxDepth]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => sanitizeForLog(item, depth + 1));
  if (!value || typeof value !== "object") {
    const text = String(value ?? "");
    return text.length > 1000 ? `${text.slice(0, 1000)}...` : value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (/authorization|token|secret|api[_-]?key|password/i.test(key)) {
        return [key, "[REDACTED]"];
      }
      return [key, sanitizeForLog(item, depth + 1)];
    })
  );
}

function timingSafeEqualString(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyWebhookSecret(req) {
  const expected = cleanString(process.env.JARVIS_GHL_WEBHOOK_SECRET);
  if (!expected) {
    const error = new Error("JARVIS_GHL_WEBHOOK_SECRET is not set");
    error.statusCode = 500;
    throw error;
  }

  const authorization = cleanString(req.headers.authorization).replace(
    /^Bearer\s+/i,
    ""
  );
  const provided =
    cleanString(req.headers["x-jarvis-ghl-webhook-secret"]) ||
    cleanString(req.headers["x-ghl-secret"]) ||
    cleanString(req.headers["x-webhook-secret"]) ||
    authorization ||
    cleanString(req.query?.secret);

  if (!provided || !timingSafeEqualString(provided, expected)) {
    const error = new Error("Unauthorized");
    error.statusCode = 401;
    throw error;
  }
}

module.exports = {
  parseInboundGhlMessage,
  sanitizeForLog,
  verifyWebhookSecret,
};
