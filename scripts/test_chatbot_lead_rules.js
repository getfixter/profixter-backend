const assert = require("node:assert/strict");
const {
  ABSOLUTE_URLS,
  buildCallbackConfirmationPrompt,
  buildDeclinedCallbackReply,
  buildRoutingReply,
  confirmsPhoneCall,
  declinesPhoneCall,
  extractPhoneNumber,
  getRoutingRecommendation,
  isAwaitingCallbackConfirmation,
  shouldRouteToProductPage,
  wantsPhoneCall,
} = require("../utils/chatbotLeadRules");
const knowledge = require("../data/chatbotKnowledge");
const chatbot = require("../routes/chatbot");
const { _reset: resetRateLimits } = require("../utils/rateLimit");

const booking = getRoutingRecommendation("I want to book a handyman appointment");
assert.equal(booking.type, "book");
assert.equal(booking.url, "https://profixter.com/book");
assert.equal(shouldRouteToProductPage("I want to book a handyman appointment", booking), true);
assert.ok(buildRoutingReply(booking).includes("https://profixter.com/book"));

const helpOnly = getRoutingRecommendation("My faucet is leaking. What should I check first?");
assert.equal(helpOnly.type, "book");
assert.equal(
  shouldRouteToProductPage("My faucet is leaking. What should I check first?", helpOnly),
  false
);

const needsSomeone = getRoutingRecommendation("I need someone to fix my faucet");
assert.equal(needsSomeone.type, "book");
assert.equal(shouldRouteToProductPage("I need someone to fix my faucet", needsSomeone), true);

// A bathroom faucet is a handyman job, not a renovation.
assert.equal(getRoutingRecommendation("Can you fix my bathroom faucet?").type, "book");
assert.equal(getRoutingRecommendation("I want to remodel my bathroom").type, "projects");

const membership = getRoutingRecommendation("Show me membership plans");
assert.equal(membership.type, "membership");
assert.equal(membership.url, "https://profixter.com/membership/plans");
assert.equal(shouldRouteToProductPage("Show me membership plans", membership), true);

const project = getRoutingRecommendation("I need a kitchen remodel estimate");
assert.equal(project.type, "projects");
assert.equal(shouldRouteToProductPage("I need a kitchen remodel estimate", project), true);

// Gift memberships are a gift, even though the words include "membership".
const gift = getRoutingRecommendation("I want to buy a gift membership for my mom");
assert.equal(gift.type, "gift");
assert.equal(gift.url, "https://profixter.com/gift");
assert.equal(shouldRouteToProductPage("I want to buy a gift membership for my mom", gift), true);

const fullDay = getRoutingRecommendation("Can I book a full day with a Fixter?");
assert.equal(fullDay.type, "full_day");
assert.equal(fullDay.url, "https://profixter.com/book?visit=full-day");
assert.equal(shouldRouteToProductPage("Can I book a full day with a Fixter?", fullDay), true);

const freeVisit = getRoutingRecommendation("How do I get my free first visit?");
assert.equal(freeVisit.type, "free_visit");
assert.equal(shouldRouteToProductPage("How do I get my free first visit?", freeVisit), true);
assert.ok(freeVisit.reason.includes("90 minutes"));
// A question about the offer is answered, not bounced to a page.
assert.equal(shouldRouteToProductPage("Is the first visit really free?"), false);

assert.equal(wantsPhoneCall("Can someone call me?"), true);
assert.equal(confirmsPhoneCall("yes, call me"), true);
assert.equal(confirmsPhoneCall("yes"), false);
assert.equal(declinesPhoneCall("no thanks"), true);
assert.equal(extractPhoneNumber("Please call 631-555-1212"), "631-555-1212");

const prompt = buildCallbackConfirmationPrompt();
assert.ok(prompt.includes("Reply \"Yes, call me\""));
assert.equal(
  isAwaitingCallbackConfirmation([
    { role: "assistant", content: prompt },
  ]),
  true
);
assert.equal(
  isAwaitingCallbackConfirmation([
    { role: "assistant", meta: { kind: "callback_confirmation_prompt" } },
  ]),
  true
);

/*
 * No reply, link, prompt or knowledge line may send anyone to a retired page:
 * /home-support (the old "Profixter AI") or anything Studio.
 */
const RETIRED = [/home-support/i, /profixter ai\b/i, /studio/i, /3d/i];
const samples = [
  "I want to book a handyman appointment",
  "Show me membership plans",
  "I need a kitchen remodel estimate",
  "I want to buy a gift membership",
  "Can I book a full day?",
  "How do I get my free first visit?",
  "Can you design my new shower?",
  "I want a bathroom mockup",
  "Can I upload a photo of my contractor quote?",
  "What does it cost?",
];
const texts = [
  prompt,
  buildDeclinedCallbackReply(),
  chatbot.SYSTEM_PROMPT,
  knowledge.toModelContext(),
  ...Object.values(ABSOLUTE_URLS),
  ...samples.map((s) => buildRoutingReply(getRoutingRecommendation(s))),
];
for (const text of texts) {
  for (const pattern of RETIRED) {
    assert.ok(!pattern.test(text.replace(/no separate AI product, photo upload, design studio or 3D tool/i, "")), `retired reference ${pattern} in: ${text.slice(0, 120)}`);
  }
}
for (const url of Object.values(ABSOLUTE_URLS)) {
  assert.ok(url.startsWith("https://profixter.com/"), url);
}

/* The facts the assistant quotes match the website's. */
const ctx = knowledge.toModelContext();
for (const fact of ["$149/mo", "$249/mo", "$349/mo", "$499/mo", "$99", "90 minutes", "631-599-1363", "HI-71484", "8 AM - 6 PM"]) {
  assert.ok(ctx.includes(fact), `knowledge is missing ${fact}`);
}
assert.ok(!/unlimited visits|free trial|cancel anytime/i.test(ctx));
assert.ok(!/New York State license|NYS/i.test(ctx.replace("Do not call it a New York State license", "")));

/* Abuse limits: per-IP rate limit and an input cap, answered as SSE. */
function fakeRes() {
  return {
    headers: {},
    body: "",
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    write(chunk) { this.body += chunk; },
    end() { this.ended = true; },
  };
}
function fakeReq(ip) {
  return { headers: { "x-forwarded-for": `10.0.0.1, ${ip}` }, socket: { remoteAddress: "10.0.0.2" }, body: {} };
}
resetRateLimits();
let passed = 0;
for (let i = 0; i < chatbot.CHAT_LIMIT.limit; i++) {
  chatbot.chatbotRateLimit(fakeReq("203.0.113.7"), fakeRes(), () => { passed += 1; });
}
assert.equal(passed, chatbot.CHAT_LIMIT.limit);
const limited = fakeRes();
let nextCalled = false;
chatbot.chatbotRateLimit(fakeReq("203.0.113.7"), limited, () => { nextCalled = true; });
assert.equal(nextCalled, false);
assert.equal(limited.ended, true);
assert.equal(limited.headers["content-type"], "text/event-stream");
const event = JSON.parse(limited.body.replace(/^data:\s*/, ""));
assert.equal(event.code, "rate_limited");
assert.ok(event.error.includes("631-599-1363"));
assert.ok(event.retryAfterSeconds > 0);
// Another address is not affected.
let otherPassed = false;
chatbot.chatbotRateLimit(fakeReq("198.51.100.9"), fakeRes(), () => { otherPassed = true; });
assert.equal(otherPassed, true);
resetRateLimits();
assert.equal(chatbot.MAX_INPUT_CHARS, 1000);

/* The route itself refuses an oversized message and a missing visitor id before touching the database. */
(async () => {
  const express = require("express");
  const fetch = require("node-fetch");
  const app = express();
  app.use(express.json());
  app.use("/api/chatbot", chatbot);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/api/chatbot/message`;
  const post = async (body) => {
    const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return JSON.parse((await res.text()).replace(/^data:\s*/, "").trim());
  };
  try {
    const tooLong = await post({ visitorId: "visitor-test", input: "x".repeat(1001) });
    assert.equal(tooLong.code, "input_too_long");
    const noVisitor = await post({ input: "hello" });
    assert.equal(noVisitor.error, "Missing visitor id");
  } finally {
    server.close();
    resetRateLimits();
  }
  console.log("Chatbot lead routing rules passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
