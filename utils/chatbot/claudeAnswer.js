/*
 * The support chat's answer, from Claude (2026-11-03).
 *
 * The chat used OpenAI, and when that account ran out of credit every answer
 * failed silently: the response was never checked, so the stream simply had no
 * text and the visitor saw "the chat could not answer". It now uses the
 * Anthropic key the rest of the backend already loads (utils/secrets.js,
 * Parameter Store), on Claude Haiku 5.5 - the owner's choice for a fast,
 * inexpensive FAQ chat - at low effort with short answers.
 *
 * Failures are never silent: a missing key, a provider error (status and type,
 * never the key), a timeout or a refusal throws ChatProviderError, which the
 * route logs and answers from the knowledge base instead (fallbackAnswer.js).
 */
const MODEL = "claude-haiku-5-5";
const TIMEOUT_MS = 20000;

class ChatProviderError extends Error {
  constructor(message, { code = "provider_error", status = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/* The Messages API wants a conversation that starts with the visitor. */
function toMessages(history) {
  const out = [];
  for (const m of history || []) {
    if (m?.role !== "user" && m?.role !== "assistant") continue;
    const content = String(m.content || "").trim();
    if (!content) continue;
    if (!out.length && m.role !== "user") continue;
    out.push({ role: m.role, content });
  }
  return out;
}

/**
 * Stream an answer. `onToken(text)` receives each piece as it arrives.
 * Returns the full text. Throws ChatProviderError on any failure.
 */
async function claudeAnswer({ system, knowledge, history, onToken, client = null }) {
  if (!client && !process.env.ANTHROPIC_API_KEY) {
    throw new ChatProviderError("No Anthropic key loaded", { code: "no_api_key" });
  }
  const messages = toMessages(history);
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    throw new ChatProviderError("Nothing to answer", { code: "empty_history" });
  }
  const { Anthropic } = require("@anthropic-ai/sdk");
  const api = client || new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 });
  let text = "";
  try {
    const stream = api.messages.stream({
      model: MODEL,
      max_tokens: 1024,
      // A short FAQ answer: low effort keeps it fast and inexpensive.
      output_config: { effort: "low" },
      system: [
        { type: "text", text: system },
        // The knowledge base is the same on every request: let it be cached.
        { type: "text", text: knowledge, cache_control: { type: "ephemeral" } },
      ],
      messages,
    });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        text += event.delta.text;
        if (onToken) onToken(event.delta.text);
      }
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") throw new ChatProviderError("Declined", { code: "refusal" });
  } catch (error) {
    if (error instanceof ChatProviderError) throw error;
    const { Anthropic } = require("@anthropic-ai/sdk");
    if (error instanceof Anthropic.APIError) {
      throw new ChatProviderError(`Anthropic ${error.status || ""} ${error.error?.error?.type || error.name}`.trim(), {
        code: error.error?.error?.type || "api_error",
        status: error.status ?? null,
      });
    }
    throw new ChatProviderError(String(error?.message || error).slice(0, 120), { code: "network_or_timeout" });
  }
  text = text.trim();
  if (!text) throw new ChatProviderError("Empty answer", { code: "empty_answer" });
  return text;
}

module.exports = { claudeAnswer, ChatProviderError, MODEL, toMessages };
