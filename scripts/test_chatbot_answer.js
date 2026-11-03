/*
 * The support chat answers (2026-11-03): Claude Haiku 5.5 through
 * utils/chatbot/claudeAnswer.js, and the knowledge-base answer when the
 * provider cannot (out of credit, down, timeout). No network: a fake client.
 *
 *   node scripts/test_chatbot_answer.js
 */
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
const assert = require("assert");
const { claudeAnswer, ChatProviderError, toMessages, MODEL } = require("../utils/chatbot/claudeAnswer");
const { fallbackAnswer } = require("../utils/chatbot/fallbackAnswer");

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}
/* A client whose stream yields these text pieces, or throws. */
function fakeClient({ pieces = [], throwError = null, stopReason = "end_turn", seen = {} } = {}) {
  return {
    messages: {
      stream(params) {
        seen.params = params;
        return {
          async *[Symbol.asyncIterator]() {
            if (throwError) throw throwError;
            for (const text of pieces) yield { type: "content_block_delta", delta: { type: "text_delta", text } };
          },
          async finalMessage() {
            return { stop_reason: stopReason };
          },
        };
      },
    },
  };
}
const SYSTEM = "You are the Profixter Assistant.";
const KNOWLEDGE = "Free Visit: repairs and labor are not included.";
const one = (content) => [{ role: "user", content }];

(async () => {
  console.log("\nClaude answers");
  await check("streams the answer piece by piece and returns it whole", async () => {
    const got = [];
    const seen = {};
    const text = await claudeAnswer({ system: SYSTEM, knowledge: KNOWLEDGE, history: one("What is the Free Visit?"), onToken: (t) => got.push(t), client: fakeClient({ pieces: ["The Free Visit ", "has no labor."], seen }) });
    assert.strictEqual(text, "The Free Visit has no labor.");
    assert.deepStrictEqual(got, ["The Free Visit ", "has no labor."]);
    assert.strictEqual(seen.params.model, "claude-haiku-5-5");
    assert.strictEqual(MODEL, "claude-haiku-5-5");
    assert.strictEqual(seen.params.output_config.effort, "low");
    assert.ok(!("temperature" in seen.params), "no sampling parameters (Haiku 5.5 rejects them)");
    assert.strictEqual(seen.params.system[1].cache_control.type, "ephemeral", "the knowledge base is cacheable");
  });
  await check("the conversation sent starts with the visitor and skips empty or system turns", async () => {
    const m = toMessages([
      { role: "assistant", content: "Hi!" },
      { role: "system", content: "old prompt" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "Price?" },
    ]);
    assert.deepStrictEqual(m.map((x) => x.role), ["user", "assistant", "user"]);
  });
  await check("a network or timeout failure is a ChatProviderError (never silent)", async () => {
    await assert.rejects(
      claudeAnswer({ system: SYSTEM, knowledge: KNOWLEDGE, history: one("hi"), client: fakeClient({ throwError: new Error("socket hang up") }) }),
      (e) => e instanceof ChatProviderError && e.code === "network_or_timeout"
    );
  });
  await check("an Anthropic API error keeps its status and type", async () => {
    const { Anthropic } = require("@anthropic-ai/sdk");
    const apiErr = Anthropic.APIError.generate(429, { type: "error", error: { type: "rate_limit_error", message: "slow down" } }, "slow down", new Headers());
    await assert.rejects(
      claudeAnswer({ system: SYSTEM, knowledge: KNOWLEDGE, history: one("hi"), client: fakeClient({ throwError: apiErr }) }),
      (e) => e instanceof ChatProviderError && e.status === 429 && e.code === "rate_limit_error"
    );
  });
  await check("a refusal or an empty answer is a failure too", async () => {
    await assert.rejects(claudeAnswer({ system: SYSTEM, knowledge: KNOWLEDGE, history: one("hi"), client: fakeClient({ pieces: ["x"], stopReason: "refusal" }) }), (e) => e.code === "refusal");
    await assert.rejects(claudeAnswer({ system: SYSTEM, knowledge: KNOWLEDGE, history: one("hi"), client: fakeClient({ pieces: [] }) }), (e) => e.code === "empty_answer");
  });
  await check("no key loaded is reported as no_api_key", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await assert.rejects(claudeAnswer({ system: SYSTEM, knowledge: KNOWLEDGE, history: one("hi") }), (e) => e.code === "no_api_key");
    } finally {
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  console.log("\nWhen the AI cannot answer: the knowledge base does");
  const ask = (q) => fallbackAnswer(q);
  await check("Free Visit: free, to-do list, NO repairs or labor, no account, the right link", async () => {
    const a = ask("What is the Free Visit?");
    assert.strictEqual(a.key, "free_visit");
    assert.ok(/not included/i.test(a.text) && /book\/free/.test(a.text) && /without an account/i.test(a.text), a.text);
  });
  await check("One-Time Visit: $99, one small task, up to 90 minutes", async () => {
    const a = ask("What is a one-time visit?");
    assert.ok(a.key === "one_time" && /\$99/.test(a.text) && /90 minutes/.test(a.text), a.text);
  });
  await check("Membership: from $149 a month, labor included for covered tasks, annual 10 for 12", async () => {
    const a = ask("How much is a membership?");
    assert.ok(a.key === "membership" && /\$149/.test(a.text) && /labor is included for covered tasks/i.test(a.text) && /10 months for 12/.test(a.text), a.text);
  });
  await check("booking, service area, renovations and the default all answer correctly", async () => {
    assert.ok(/book\/handyman/.test(ask("How do I book an appointment?").text));
    assert.ok(/Nassau and Suffolk/.test(ask("Do you serve my town?").text));
    assert.ok(/projects#estimate/.test(ask("Can you renovate my kitchen?").text));
    const d = ask("hello there");
    assert.ok(d.key === "default" && /631-599-1363/.test(d.text));
  });
  await check("no fallback answer promises free labor, a free trial, unlimited visits or cancel anytime", async () => {
    for (const q of ["free visit", "one-time", "full day", "membership", "book", "area", "renovation", "gift", "hi"]) {
      const t = ask(q).text;
      assert.ok(!/free trial|unlimited|cancel anytime/i.test(t), `${q}: ${t}`);
    }
  });

  console.log("\nThe route answers even when the provider fails");
  await check("answerQuestion falls back to the knowledge base, streams it and logs why (no key in logs)", async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { answerQuestion } = require("../routes/chatbot");
    const got = [];
    const logs = [];
    const realError = console.error;
    console.error = (line) => logs.push(String(line));
    try {
      const text = await answerQuestion(one("What is the Free Visit?"), (t) => got.push(t), "What is the Free Visit?");
      assert.ok(/Repairs and labor are not included/.test(text), text);
      assert.strictEqual(got.join(""), text);
      const line = logs.find((l) => l.includes("chatbot_provider_failed"));
      assert.ok(line && /"code":"no_api_key"/.test(line) && /"fallback":"free_visit"/.test(line), line);
      assert.ok(!/sk-/.test(logs.join(" ")), "no key in logs");
    } finally {
      console.error = realError;
      if (saved) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
