const assert = require("node:assert/strict");
const {
  buildCallbackConfirmationPrompt,
  buildRoutingReply,
  confirmsPhoneCall,
  declinesPhoneCall,
  extractPhoneNumber,
  getRoutingRecommendation,
  isAwaitingCallbackConfirmation,
  shouldRouteToProductPage,
  wantsPhoneCall,
} = require("../utils/chatbotLeadRules");

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

const membership = getRoutingRecommendation("Show me membership plans");
assert.equal(membership.type, "membership");
assert.equal(shouldRouteToProductPage("Show me membership plans", membership), true);

const project = getRoutingRecommendation("I need a kitchen remodel estimate");
assert.equal(project.type, "projects");
assert.equal(shouldRouteToProductPage("I need a kitchen remodel estimate", project), true);

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

console.log("Chatbot lead routing rules passed");
