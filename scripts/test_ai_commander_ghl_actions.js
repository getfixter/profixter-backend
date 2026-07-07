const assert = require("assert");

process.env.GHL_LOCATION_ID = "test-location";

const { buildRequestForAction } = require("../src/aiCommanderGhl/ghlActions");

function testCreateContactPayload() {
  const request = buildRequestForAction({
    actionId: "action_1",
    actionType: "create_contact",
    target: {},
    payload: {
      name: "AI Test Contact",
      phone: "6315991363",
      tags: ["ai-test"],
      customFields: [{ key: "ignored_on_create", value: "not sent" }],
    },
  });

  assert.equal(request.method, "POST");
  assert.equal(request.path, "/contacts/");
  assert.deepEqual(request.body, {
    firstName: "AI",
    lastName: "Test Contact",
    phone: "+16315991363",
    tags: ["ai-test"],
    locationId: "test-location",
  });
}

testCreateContactPayload();

console.log("AI Commander GHL action payload tests passed");
