const assert = require("assert");

const { redact, redactSecretString } = require("../src/aiCommanderGhl/ghlClient");

function testRedactSecretString() {
  const input = [
    "Authorization: Bearer secret-admin-jwt",
    "jwt=eyJabc.def.ghi",
    "api_key=secret-api-key",
    '"access_token":"secret-access-token"',
  ].join(" ");
  const output = redactSecretString(input);

  assert.doesNotMatch(output, /secret-admin-jwt|secret-api-key|secret-access-token|eyJabc\.def\.ghi/);
  assert.match(output, /Bearer \[REDACTED\]/);
  assert.match(output, /api_key=\[REDACTED\]/);
}

function testRedactObject() {
  const output = redact({
    headers: {
      Authorization: "Bearer secret-admin-jwt",
    },
    token: "secret-token",
    nested: {
      message: "failed with Bearer secret-admin-jwt and apiKey=secret-api-key",
    },
  });
  const serialized = JSON.stringify(output);

  assert.doesNotMatch(serialized, /secret-admin-jwt|secret-api-key|secret-token/);
  assert.equal(output.headers.Authorization, "[REDACTED]");
  assert.equal(output.token, "[REDACTED]");
}

testRedactSecretString();
testRedactObject();
console.log("Jarvis GHL security redaction tests passed");
