const assert = require("assert");

const {
  DESTRUCTIVE_CONFIRMATION_PHRASE,
  ENDPOINTS,
  HIGH_RISK_CONFIRMATION_PHRASE,
  findEndpoint,
  registryStats,
} = require("../src/aiCommanderGhl/ghlEndpointRegistry");

function testEveryEndpointHasControlMetadata() {
  assert.ok(ENDPOINTS.length > 40, "registry should cover broad GHL areas");

  for (const endpoint of ENDPOINTS) {
    assert.ok(endpoint.key, "endpoint key is required");
    assert.ok(endpoint.group, `${endpoint.key} group is required`);
    assert.ok(endpoint.method, `${endpoint.key} method is required`);
    assert.ok(endpoint.path?.startsWith("/"), `${endpoint.key} path must be relative`);
    assert.ok(endpoint.description, `${endpoint.key} description is required`);
    assert.ok(Array.isArray(endpoint.requiredScopes), `${endpoint.key} scopes must be listed`);
    assert.ok(endpoint.riskLevel, `${endpoint.key} riskLevel is required`);
    assert.ok(endpoint.riskCategory, `${endpoint.key} riskCategory is required`);
    assert.equal(typeof endpoint.approvalRequired, "boolean", `${endpoint.key} approval flag is required`);
    assert.ok(endpoint.rateLimitProfile, `${endpoint.key} rate limit profile is required`);
    assert.ok(endpoint.auditLogPolicy, `${endpoint.key} audit policy is required`);

    if (!endpoint.readOnly && endpoint.enabled !== false && endpoint.deprecated !== true) {
      assert.equal(endpoint.approvalRequired, true, `${endpoint.key} write must require approval`);
    }
  }
}

function testRiskPhrases() {
  const messageSend = findEndpoint({ method: "POST", path: "/conversations/messages" }).endpoint;
  assert.equal(messageSend.riskCategory, "high-risk");
  assert.equal(messageSend.confirmationPhrase, HIGH_RISK_CONFIRMATION_PHRASE);
  assert.equal(messageSend.requiresExtraConfirmation, true);

  const contactDelete = findEndpoint({ method: "DELETE", path: "/contacts/contact-1" }).endpoint;
  assert.equal(contactDelete.riskCategory, "destructive");
  assert.equal(contactDelete.confirmationPhrase, DESTRUCTIVE_CONFIRMATION_PHRASE);
  assert.equal(contactDelete.requiresExtraConfirmation, true);
}

function testDeprecatedEndpointsDisabled() {
  const deprecated = ENDPOINTS.filter((endpoint) => endpoint.deprecated);
  assert.ok(deprecated.length > 0);
  deprecated.forEach((endpoint) => assert.equal(endpoint.enabled, false));
}

function testRegistryStats() {
  const stats = registryStats();
  assert.ok(stats.enabled > 20);
  assert.ok(stats.read > 10);
  assert.ok(stats.write > 10);
  assert.ok(stats.highRisk > 0);
  assert.ok(stats.destructive > 0);
  assert.ok(stats.groups.contacts.enabled > 0);
  assert.ok(stats.groups.campaigns.enabled > 0);
}

function main() {
  testEveryEndpointHasControlMetadata();
  testRiskPhrases();
  testDeprecatedEndpointsDisabled();
  testRegistryStats();
  console.log("GHL endpoint registry tests passed.");
}

main();
