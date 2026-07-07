const fetch = require("node-fetch");

const CLASSIFICATION_VALUES = [
  "interested",
  "maybe_interested",
  "wants_call",
  "gave_callback_time",
  "not_interested",
  "stop_unsubscribe",
  "pricing_question",
  "technical_question",
  "angry_or_complaint",
  "wrong_number",
  "unclear",
  "human_takeover",
];

const ACTION_TYPES = [
  "store_suggested_reply",
  "send_sms_reply",
  "add_tag",
  "create_or_update_opportunity",
  "create_task",
  "create_note",
  "notify_admin",
  "stop_ai",
  "human_takeover",
  "unsupported",
];

const CLASSIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "classification",
    "recommendedReply",
    "callbackTimeText",
    "actionsPlanned",
    "humanTakeover",
  ],
  properties: {
    classification: { type: "string", enum: CLASSIFICATION_VALUES },
    recommendedReply: { type: "string" },
    callbackTimeText: { type: "string" },
    actionsPlanned: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["actionType", "description", "supported", "reason"],
        properties: {
          actionType: { type: "string", enum: ACTION_TYPES },
          description: { type: "string" },
          supported: { type: "boolean" },
          reason: { type: "string" },
        },
      },
    },
    humanTakeover: { type: "boolean" },
  },
};

function cleanString(value) {
  return String(value || "").trim();
}

function normalizeHistory(history = []) {
  if (!Array.isArray(history)) return [];
  return history
    .slice(-10)
    .map((message) => {
      if (typeof message === "string") {
        return { role: "user", content: cleanString(message) };
      }
      const role = ["user", "assistant", "system"].includes(message?.role)
        ? message.role
        : "user";
      return { role, content: cleanString(message?.content || message?.message) };
    })
    .filter((message) => message.content);
}

function buildRoofingSalesAgentPrompt() {
  return `
You are Roofing Sales Agent v1, a specialized internal Jarvis skill for Profixter roofing/siding estimate leads.

Mission:
- Turn inbound SMS replies into permission for Taras to call and a callback time.
- Do not sell the roof, negotiate, quote, estimate, promise discounts, promise availability, discuss insurance claims, argue, or go deep on roofing/siding technical details.
- Keep SMS replies short, warm, plain, and natural.
- Main objective: get consent for a quick call with Taras and the best callback time.

Classify the newest lead message as exactly one category:
- interested
- maybe_interested
- wants_call
- gave_callback_time
- not_interested
- stop_unsubscribe
- pricing_question
- technical_question
- angry_or_complaint
- wrong_number
- unclear
- human_takeover

Response policy:
- interested or maybe_interested: ask whether Taras can give them a quick call and whether today or tomorrow works.
- wants_call: ask what time works best.
- gave_callback_time: confirm politely and say you will let Taras know.
- pricing_question: do not quote. Say Taras can review the project and see if Profixter can offer a better number, then ask if today or tomorrow works for a quick call.
- technical_question: keep it short, say Taras can discuss details on the call, then ask for callback time.
- not_interested: recommendedReply may be a short polite acknowledgement, but mark stop_ai in actions.
- stop_unsubscribe: do not write a marketing reply. Use an empty recommendedReply unless a legally required opt-out confirmation is obvious.
- angry_or_complaint: stop AI and hand off.
- wrong_number: stop AI.
- unclear: ask one simple clarifying question.

Return strict JSON only. Never include pricing, estimates, discounts, insurance advice, technical diagnosis, bulk SMS, tokens, or API details.
`.trim();
}

function outputTextFromResponse(data) {
  if (data?.output_text) return String(data.output_text);
  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "refusal" && content?.refusal) {
        const error = new Error(content.refusal);
        error.statusCode = 400;
        throw error;
      }
      if (content?.type === "output_text" && content?.text) {
        chunks.push(content.text);
      } else if (content?.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

function parsedOutputFromResponse(data) {
  if (data?.output_parsed && typeof data.output_parsed === "object") {
    return data.output_parsed;
  }
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.parsed && typeof content.parsed === "object") {
        return content.parsed;
      }
    }
  }
  return null;
}

async function classifyRoofingLeadReply({
  contactName,
  phone,
  incomingMessage,
  conversationHistory = [],
}) {
  const apiKey = cleanString(process.env.OPENAI_API_KEY);
  if (!apiKey) {
    const error = new Error("Missing OPENAI_API_KEY");
    error.statusCode = 500;
    throw error;
  }

  const payload = {
    contactName: cleanString(contactName),
    phone: cleanString(phone),
    incomingMessage: cleanString(incomingMessage),
    conversationHistory: normalizeHistory(conversationHistory),
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model:
        cleanString(process.env.JARVIS_ROOFING_AGENT_OPENAI_MODEL) ||
        cleanString(process.env.AI_COMMANDER_OPENAI_MODEL) ||
        "gpt-4o-mini",
      instructions: buildRoofingSalesAgentPrompt(),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(payload),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "roofing_sales_agent_classification",
          strict: true,
          schema: CLASSIFICATION_SCHEMA,
        },
      },
      max_output_tokens: 1500,
      store: false,
      temperature: 0.2,
    }),
  });

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const error = new Error(
      `OpenAI roofing sales classification failed: ${response.status} ${
        data?.error?.message || raw || ""
      }`.trim()
    );
    error.statusCode = 502;
    throw error;
  }

  const parsed = parsedOutputFromResponse(data);
  if (parsed) return parsed;

  const text = outputTextFromResponse(data);
  if (!text) {
    const error = new Error("OpenAI returned an empty roofing sales classification");
    error.statusCode = 502;
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    error.message = `OpenAI returned invalid JSON: ${error.message}`;
    error.statusCode = 502;
    throw error;
  }
}

module.exports = {
  ACTION_TYPES,
  CLASSIFICATION_SCHEMA,
  CLASSIFICATION_VALUES,
  buildRoofingSalesAgentPrompt,
  classifyRoofingLeadReply,
  normalizeHistory,
};
