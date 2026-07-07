const assert = require("node:assert/strict");

process.env.GHL_LOCATION_ID = "test-location";
process.env.GHL_AI_COMMANDER_TOKEN = "test-token";
delete process.env.JARVIS_ROOFING_AGENT_PIPELINE_ID;

const {
  parseInboundGhlMessage,
} = require("../src/jarvisSkills/roofingSalesAgent/roofingSalesAgent.webhook");
const {
  buildActionsPlanned,
  callbackTaskDueDate,
  safeToAutoReply,
  statusForClassification,
} = require("../src/jarvisSkills/roofingSalesAgent/roofingSalesAgent.service");

function testWebhookParsing() {
  const parsed = parseInboundGhlMessage({
    contact: {
      id: "contact-1",
      firstName: "John",
      lastName: "Roof",
      phone: "(631) 555-0100",
    },
    message: {
      id: "msg-1",
      body: "tomorrow after 5",
      conversationId: "conversation-1",
    },
  });

  assert.equal(parsed.contactId, "contact-1");
  assert.equal(parsed.name, "John Roof");
  assert.equal(parsed.phone, "+16315550100");
  assert.equal(parsed.incomingMessage, "tomorrow after 5");
  assert.equal(parsed.conversationId, "conversation-1");
  assert.equal(parsed.messageId, "msg-1");
}

function testSafetyStatuses() {
  assert.equal(safeToAutoReply("gave_callback_time"), true);
  assert.equal(safeToAutoReply("pricing_question"), true);
  assert.equal(safeToAutoReply("not_interested"), false);
  assert.equal(safeToAutoReply("stop_unsubscribe"), false);
  assert.equal(safeToAutoReply("angry_or_complaint"), false);

  assert.equal(statusForClassification("gave_callback_time"), "callback_scheduled");
  assert.equal(statusForClassification("stop_unsubscribe"), "do_not_contact");
  assert.equal(statusForClassification("not_interested"), "closed_not_interested");
  assert.equal(statusForClassification("pricing_question"), "waiting_for_callback_time");
}

function testDueDateParsing() {
  const due = callbackTaskDueDate(
    "tomorrow after 5",
    new Date("2026-07-07T14:00:00.000Z")
  );
  assert.equal(due, "2026-07-08T21:00:00.000Z");
}

function testCallbackActionPlanning() {
  const actions = buildActionsPlanned({
    conversation: {
      contactId: "contact-1",
      phone: "+16315550100",
      name: "John Roof",
      campaignType: "roofing_siding",
      lastIncomingMessage: "tomorrow after 5",
    },
    classification: "gave_callback_time",
    recommendedReply:
      "Perfect - I will let Taras know to call you tomorrow after 5. Thank you.",
    callbackTimeText: "tomorrow after 5",
  });

  assert(actions.some((action) => action.actionType === "add_contact_tags"));
  assert(actions.some((action) => action.actionType === "create_contact_task"));
  assert(actions.some((action) => action.actionType === "create_contact_note"));
  assert(actions.some((action) => action.actionType === "notify_admin"));
  assert(
    actions.some(
      (action) =>
        action.actionType === "create_or_update_opportunity" &&
        action.supported === false &&
        /PIPELINE_ID/.test(action.reason)
    )
  );
}

function run() {
  testWebhookParsing();
  testSafetyStatuses();
  testDueDateParsing();
  testCallbackActionPlanning();
  console.log("Roofing Sales Agent tests passed");
}

run();
