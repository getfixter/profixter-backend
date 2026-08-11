/**
 * E-signature layer — unit tests.
 *
 * Covers provider status mapping, webhook authentication and payload parsing,
 * event idempotency, and the document status projection. No database, no
 * network, no Adobe credentials required.
 *
 *   node scripts/test_esign_signature_flow.js
 */

// s3.js refuses to load without a bucket name; the tests never call it.
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";

const assert = require("assert");
const http = require("http");
const express = require("express");

const adobe = require("../utils/esign/adobeSignClient");
const signatureService = require("../utils/esign/signatureService");
const esignWebhook = require("../routes/esignWebhook");
const ESignature = require("../models/ESignature");
const bootstrap = require("./adobe_oauth_bootstrap");
const provisioner = require("../utils/esign/webhookProvisioner");

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  FAIL  ${name}\n        ${err.message}`);
  }
}

/** A stand-in for a saved ESignature document, with the methods applyEvent uses. */
function fakeSignature(overrides = {}) {
  const signature = {
    _id: "sig-1",
    provider: "adobe_sign",
    documentType: "CHANGE_ORDER",
    status: "Sent",
    providerStatus: "OUT_FOR_SIGNATURE",
    providerAgreementId: "AGREEMENT-123",
    processedEvents: [],
    signers: [
      { email: "jane@example.com", role: "CUSTOMER", status: "Pending", viewedAt: null, signedAt: null },
    ],
    documentRetrieval: { state: "not_needed", attempts: 0 },
    saveCount: 0,
    ...overrides,
  };
  signature.hasProcessedEvent = (id) =>
    !id ? false : signature.processedEvents.some((event) => event.providerEventId === String(id));
  signature.isTerminal = () =>
    ["Completed", "Declined", "Cancelled", "Expired"].includes(signature.status);
  signature.save = async () => {
    signature.saveCount += 1;
    return signature;
  };
  return signature;
}

/** Start the webhook router on an ephemeral port. */
function startWebhookServer() {
  const app = express();
  app.use(express.json());
  app.use("/api/esign/webhook", esignWebhook);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function main() {
  /* ---------------- provider status mapping ---------------- */

  console.log("\nAdobe agreement status mapping");

  await test("SIGNED means completed", () =>
    assert.strictEqual(adobe.mapAgreementStatus("SIGNED"), "Completed"));

  await test("OUT_FOR_SIGNATURE means awaiting signature", () =>
    assert.strictEqual(adobe.mapAgreementStatus("OUT_FOR_SIGNATURE"), "Awaiting Signature"));

  await test("WAITING_FOR_MY_SIGNATURE means partially signed, not completed", () =>
    assert.strictEqual(adobe.mapAgreementStatus("WAITING_FOR_MY_SIGNATURE"), "Partially Signed"));

  await test("ABORTED and REJECTED both mean declined", () => {
    assert.strictEqual(adobe.mapAgreementStatus("ABORTED"), "Declined");
    assert.strictEqual(adobe.mapAgreementStatus("REJECTED"), "Declined");
  });

  await test("RECALLED and CANCELLED both mean cancelled", () => {
    assert.strictEqual(adobe.mapAgreementStatus("RECALLED"), "Cancelled");
    assert.strictEqual(adobe.mapAgreementStatus("CANCELLED"), "Cancelled");
  });

  await test("EXPIRED means expired", () =>
    assert.strictEqual(adobe.mapAgreementStatus("EXPIRED"), "Expired"));

  await test("status mapping is case insensitive", () =>
    assert.strictEqual(adobe.mapAgreementStatus("signed"), "Completed"));

  await test("an unknown status never silently becomes completed", () => {
    const mapped = adobe.mapAgreementStatus("SOMETHING_NEW_FROM_ADOBE");
    assert.notStrictEqual(mapped, "Completed");
    assert.ok(ESignature.SIGNATURE_STATUSES.includes(mapped));
  });

  await test("every mapped status is a real ProFixter signature status", () => {
    for (const value of Object.values(adobe.AGREEMENT_STATUS_MAP)) {
      assert.ok(
        ESignature.SIGNATURE_STATUSES.includes(value),
        `${value} is not a valid signature status`
      );
    }
  });

  /* ---------------- webhook event mapping ---------------- */

  console.log("\nAdobe webhook event mapping");

  await test("AGREEMENT_WORKFLOW_COMPLETED is the completion event", () =>
    assert.strictEqual(adobe.mapWebhookEvent("AGREEMENT_WORKFLOW_COMPLETED"), "completed"));

  await test("AGREEMENT_ACTION_COMPLETED is one signer, not the whole agreement", () =>
    assert.strictEqual(adobe.mapWebhookEvent("AGREEMENT_ACTION_COMPLETED"), "signer_completed"));

  await test("exactly one Adobe event maps to completion", () => {
    const completing = Object.entries(adobe.WEBHOOK_EVENT_MAP).filter(
      ([, normalized]) => normalized === "completed"
    );
    assert.strictEqual(completing.length, 1);
    assert.strictEqual(completing[0][0], "AGREEMENT_WORKFLOW_COMPLETED");
  });

  await test("an unknown event maps to null rather than a guess", () =>
    assert.strictEqual(adobe.mapWebhookEvent("AGREEMENT_SOMETHING_ELSE"), null));

  /* ---------------- webhook provisioning ---------------- */

  console.log("\nWebhook provisioning");

  await test("the eight events ProFixter acts on are all subscribed", () => {
    for (const event of [
      "AGREEMENT_CREATED",
      "AGREEMENT_ACTION_REQUESTED",
      "AGREEMENT_EMAIL_VIEWED",
      "AGREEMENT_ACTION_COMPLETED",
      "AGREEMENT_WORKFLOW_COMPLETED",
      "AGREEMENT_REJECTED",
      "AGREEMENT_RECALLED",
      "AGREEMENT_EXPIRED",
    ]) {
      assert.ok(provisioner.WEBHOOK_EVENTS.includes(event), `missing subscription: ${event}`);
    }
  });

  await test("every subscribed event is one the client can map", () => {
    for (const event of provisioner.WEBHOOK_EVENTS) {
      assert.ok(
        adobe.mapWebhookEvent(event) !== null,
        `${event} is subscribed but maps to nothing`
      );
    }
  });

  await test("the webhook URL is built from the public base URL", () => {
    const saved = process.env.PUBLIC_API_BASE_URL;
    process.env.PUBLIC_API_BASE_URL = "https://api.profixter.com";
    try {
      assert.strictEqual(
        provisioner.webhookUrl(),
        "https://api.profixter.com/api/esign/webhook/adobe-sign"
      );
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_API_BASE_URL;
      else process.env.PUBLIC_API_BASE_URL = saved;
    }
  });

  await test("a trailing slash on the base URL does not double up", () => {
    const saved = process.env.PUBLIC_API_BASE_URL;
    process.env.PUBLIC_API_BASE_URL = "https://api.profixter.com/";
    try {
      assert.strictEqual(
        provisioner.webhookUrl(),
        "https://api.profixter.com/api/esign/webhook/adobe-sign"
      );
    } finally {
      if (saved === undefined) delete process.env.PUBLIC_API_BASE_URL;
      else process.env.PUBLIC_API_BASE_URL = saved;
    }
  });

  await test("no public base URL yields no webhook URL rather than a broken one", () => {
    const saved = process.env.PUBLIC_API_BASE_URL;
    delete process.env.PUBLIC_API_BASE_URL;
    try {
      assert.strictEqual(provisioner.webhookUrl(), "");
    } finally {
      if (saved !== undefined) process.env.PUBLIC_API_BASE_URL = saved;
    }
  });

  await test("URL comparison ignores trailing slash and host case", () => {
    assert.ok(provisioner.sameUrl("https://api.profixter.com/x", "https://API.profixter.com/x/"));
    assert.ok(!provisioner.sameUrl("https://api.profixter.com/x", "https://api.profixter.com/y"));
  });

  await test("empty URLs never compare equal", () => {
    assert.ok(!provisioner.sameUrl("", ""));
    assert.ok(!provisioner.sameUrl(undefined, null));
  });

  await test("event comparison ignores order and duplicates", () => {
    assert.ok(provisioner.sameEvents(["B", "A"], ["A", "B"]));
    assert.ok(provisioner.sameEvents(["A", "A", "B"], ["B", "A"]));
    assert.ok(!provisioner.sameEvents(["A"], ["A", "B"]));
    assert.ok(!provisioner.sameEvents([], ["A"]));
  });

  await test("auto-provisioning is on by default and only off when explicitly disabled", () => {
    const saved = process.env.ESIGN_WEBHOOK_AUTO_PROVISION;
    try {
      delete process.env.ESIGN_WEBHOOK_AUTO_PROVISION;
      assert.strictEqual(provisioner.autoProvisionEnabled(), true);
      process.env.ESIGN_WEBHOOK_AUTO_PROVISION = "false";
      assert.strictEqual(provisioner.autoProvisionEnabled(), false);
      process.env.ESIGN_WEBHOOK_AUTO_PROVISION = "true";
      assert.strictEqual(provisioner.autoProvisionEnabled(), true);
    } finally {
      if (saved === undefined) delete process.env.ESIGN_WEBHOOK_AUTO_PROVISION;
      else process.env.ESIGN_WEBHOOK_AUTO_PROVISION = saved;
    }
  });

  await test("ensureWebhook refuses to run without a public base URL", () =>
    assert.rejects(
      () => provisioner.ensureWebhook({ url: "" }),
      /PUBLIC_API_BASE_URL/
    ));

  /* ---------------- shard resolution ---------------- */

  console.log("\nShard resolution");

  await test("a shard is read from the API host", () =>
    assert.strictEqual(bootstrap.shardFromText("https://api.na4.adobesign.com"), "na4"));

  await test("a shard is read from the secure host", () =>
    assert.strictEqual(
      bootstrap.shardFromText("https://secure.na4.adobesign.com/public/oauth/v2"),
      "na4"
    ));

  await test("a shard is read from a per-account web host", () =>
    assert.strictEqual(
      bootstrap.shardFromText("https://premiumislandhomes.na4.adobesign.com/account/home"),
      "na4"
    ));

  await test("non-NA regions parse too", () => {
    assert.strictEqual(bootstrap.shardFromText("https://api.eu2.adobesign.com"), "eu2");
    assert.strictEqual(bootstrap.shardFromText("https://api.jp1.adobesign.com"), "jp1");
  });

  await test("shard parsing is case insensitive", () =>
    assert.strictEqual(bootstrap.shardFromText("https://SECURE.NA4.ADOBESIGN.COM/"), "na4"));

  await test("the shardless partner host yields no shard rather than a wrong guess", () =>
    assert.strictEqual(bootstrap.shardFromText("https://secure.adobesign.com/public/oauth/v2"), ""));

  await test("an unrelated URL yields no shard", () =>
    assert.strictEqual(bootstrap.shardFromText("https://profixter.com/admin"), ""));

  await test("empty input is handled", () => {
    assert.strictEqual(bootstrap.shardFromText(""), "");
    assert.strictEqual(bootstrap.shardFromText(undefined), "");
  });

  await test("valid shard codes are accepted by shape, not by allowlist", () => {
    for (const shard of ["na1", "na4", "eu1", "eu2", "jp1", "au1", "in1", "sg1", "ca1"]) {
      assert.ok(bootstrap.SHARD_PATTERN.test(shard), `${shard} should be valid`);
    }
  });

  await test("malformed shard codes are rejected", () => {
    for (const bad of ["", "na", "1na", "na-4", "NA4", "adobesign", "na444"]) {
      assert.ok(!bootstrap.SHARD_PATTERN.test(bad), `${bad} should be rejected`);
    }
  });

  await test("hosts are built from the resolved shard, never a hard-coded region", () => {
    assert.strictEqual(bootstrap.authorizeHost("na4"), "https://secure.na4.adobesign.com");
    assert.strictEqual(bootstrap.apiHost("na4"), "https://api.na4.adobesign.com");
    assert.strictEqual(bootstrap.authorizeHost("eu1"), "https://secure.eu1.adobesign.com");
  });

  await test("a round trip from web URL to authorization host preserves the shard", () => {
    const shard = bootstrap.shardFromText("https://premiumislandhomes.na4.adobesign.com/account");
    assert.strictEqual(
      `${bootstrap.authorizeHost(shard)}/public/oauth/v2`,
      "https://secure.na4.adobesign.com/public/oauth/v2"
    );
  });

  /* ---------------- credential safety ---------------- */

  console.log("\nCredential safety");

  const ADOBE_ENV_KEYS = [
    "ADOBE_SIGN_CLIENT_ID",
    "ADOBE_SIGN_CLIENT_SECRET",
    "ADOBE_SIGN_REFRESH_TOKEN",
    "ADOBE_SIGN_INTEGRATION_KEY",
    "ADOBE_SIGN_TOKEN_HOST",
  ];

  /** Run fn with the Adobe env replaced, then restore it exactly. */
  async function withAdobeEnv(values, fn) {
    const saved = {};
    for (const key of ADOBE_ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    Object.assign(process.env, values);
    adobe._resetTokenCache();
    try {
      return await fn();
    } finally {
      for (const key of ADOBE_ENV_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      adobe._resetTokenCache();
    }
  }

  await test("no credentials means not configured", () =>
    withAdobeEnv({}, () => {
      assert.strictEqual(adobe.isConfigured(), false);
      assert.strictEqual(adobe.authMode(), "");
    }));

  await test("a partial OAuth credential set is not treated as configured", () =>
    withAdobeEnv({ ADOBE_SIGN_CLIENT_ID: "abc", ADOBE_SIGN_CLIENT_SECRET: "def" }, () =>
      assert.strictEqual(adobe.isConfigured(), false)
    ));

  await test("a complete OAuth credential set selects the oauth mode", () =>
    withAdobeEnv(
      {
        ADOBE_SIGN_CLIENT_ID: "abc",
        ADOBE_SIGN_CLIENT_SECRET: "def",
        ADOBE_SIGN_REFRESH_TOKEN: "ghi",
      },
      () => {
        assert.strictEqual(adobe.isConfigured(), true);
        assert.strictEqual(adobe.authMode(), "oauth");
      }
    ));

  await test("an integration key alone is enough, and wins over OAuth", () =>
    withAdobeEnv(
      {
        ADOBE_SIGN_INTEGRATION_KEY: "key-123",
        ADOBE_SIGN_CLIENT_ID: "abc",
        ADOBE_SIGN_CLIENT_SECRET: "def",
        ADOBE_SIGN_REFRESH_TOKEN: "ghi",
      },
      () => {
        assert.strictEqual(adobe.isConfigured(), true);
        assert.strictEqual(adobe.authMode(), "integration_key");
      }
    ));

  await test("an unconfigured token request fails without echoing any secret", () =>
    withAdobeEnv(
      {
        ADOBE_SIGN_CLIENT_SECRET: "super-secret-value",
        ADOBE_SIGN_REFRESH_TOKEN: "refresh-token-value",
      },
      () =>
        assert.rejects(
          () => adobe.getAccessToken(),
          (error) => {
            assert.strictEqual(error.code, "NOT_CONFIGURED");
            assert.ok(!error.message.includes("super-secret-value"));
            assert.ok(!error.message.includes("refresh-token-value"));
            return true;
          }
        )
    ));

  await test("an unsupported provider is refused rather than defaulted", () =>
    assert.throws(() => signatureService.providerFor("docusign"), /Unsupported/));

  /* ---------------- token refresh ---------------- */

  console.log("\nOAuth token refresh");

  /** Stand in for Adobe's token host. `routes` maps path -> [status, body]. */
  function startTokenStub(routes) {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push(req.url);
      const route = routes[req.url];
      if (!route) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end("{}");
      }
      res.writeHead(route[0], { "Content-Type": "application/json" });
      return res.end(JSON.stringify(route[1]));
    });
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () =>
        resolve({ server, hits, host: `http://127.0.0.1:${server.address().port}` })
      );
    });
  }

  await test("refresh falls back to the legacy path only on 404", async () => {
    const stub = await startTokenStub({
      "/oauth/v2/refresh": [404, { code: "NOT_FOUND" }],
      "/oauth/refresh": [200, { access_token: "AT-1", expires_in: 3600 }],
    });
    try {
      await withAdobeEnv(
        {
          ADOBE_SIGN_CLIENT_ID: "abc",
          ADOBE_SIGN_CLIENT_SECRET: "def",
          ADOBE_SIGN_REFRESH_TOKEN: "ghi",
          ADOBE_SIGN_TOKEN_HOST: stub.host,
        },
        async () => {
          const token = await adobe.getAccessToken();
          assert.strictEqual(token.accessToken, "AT-1");
          assert.deepStrictEqual(stub.hits, ["/oauth/v2/refresh", "/oauth/refresh"]);
        }
      );
    } finally {
      stub.server.close();
    }
  });

  await test("the current path is used alone when it works", async () => {
    const stub = await startTokenStub({
      "/oauth/v2/refresh": [200, { access_token: "AT-2", expires_in: 3600 }],
    });
    try {
      await withAdobeEnv(
        {
          ADOBE_SIGN_CLIENT_ID: "abc",
          ADOBE_SIGN_CLIENT_SECRET: "def",
          ADOBE_SIGN_REFRESH_TOKEN: "ghi",
          ADOBE_SIGN_TOKEN_HOST: stub.host,
        },
        async () => {
          const token = await adobe.getAccessToken();
          assert.strictEqual(token.accessToken, "AT-2");
          assert.deepStrictEqual(stub.hits, ["/oauth/v2/refresh"]);
        }
      );
    } finally {
      stub.server.close();
    }
  });

  await test("a rejected credential fails immediately instead of retrying elsewhere", async () => {
    const stub = await startTokenStub({
      "/oauth/v2/refresh": [401, { code: "INVALID_GRANT" }],
      "/oauth/refresh": [200, { access_token: "SHOULD-NOT-BE-USED", expires_in: 3600 }],
    });
    try {
      await withAdobeEnv(
        {
          ADOBE_SIGN_CLIENT_ID: "abc",
          ADOBE_SIGN_CLIENT_SECRET: "def",
          ADOBE_SIGN_REFRESH_TOKEN: "ghi",
          ADOBE_SIGN_TOKEN_HOST: stub.host,
        },
        async () => {
          await assert.rejects(
            () => adobe.getAccessToken(),
            (error) => {
              assert.strictEqual(error.code, "TOKEN_REFRESH_FAILED");
              assert.strictEqual(error.status, 401);
              return true;
            }
          );
          assert.deepStrictEqual(stub.hits, ["/oauth/v2/refresh"]);
        }
      );
    } finally {
      stub.server.close();
    }
  });

  await test("a refresh failure never echoes the response body", async () => {
    const stub = await startTokenStub({
      "/oauth/v2/refresh": [400, { access_token: "LEAKED-TOKEN-MATERIAL" }],
    });
    try {
      await withAdobeEnv(
        {
          ADOBE_SIGN_CLIENT_ID: "abc",
          ADOBE_SIGN_CLIENT_SECRET: "def",
          ADOBE_SIGN_REFRESH_TOKEN: "ghi",
          ADOBE_SIGN_TOKEN_HOST: stub.host,
        },
        () =>
          assert.rejects(
            () => adobe.getAccessToken(),
            (error) => {
              assert.ok(!error.message.includes("LEAKED-TOKEN-MATERIAL"));
              return true;
            }
          )
      );
    } finally {
      stub.server.close();
    }
  });

  /* ---------------- storage ---------------- */

  console.log("\nPrivate storage");

  await test("stored documents live under the private prefix", () => {
    const key = signatureService.storageKey(
      {
        _id: "sig-1",
        projectId: "proj-1",
        documentType: "CHANGE_ORDER",
        documentNumber: "CO-000123-01",
      },
      "executed",
      "CO-000123-01-executed.pdf"
    );
    assert.ok(key.startsWith("private/"), `key is not private: ${key}`);
    assert.ok(key.includes("/projects/proj-1/"));
    assert.ok(key.includes("/executed/"));
    assert.ok(!key.includes("://"), "key must not be a URL");
  });

  await test("path traversal in a document number cannot escape the prefix", () => {
    const key = signatureService.storageKey(
      {
        _id: "sig-1",
        projectId: "proj-1",
        documentType: "CHANGE_ORDER",
        documentNumber: "../../../etc/passwd",
      },
      "executed",
      "../../evil.pdf"
    );
    assert.ok(key.startsWith("private/"));
    assert.ok(!key.includes(".."), `key still contains traversal: ${key}`);
  });

  /* ---------------- webhook authentication ---------------- */

  console.log("\nWebhook authentication");

  const savedClientId = process.env.ADOBE_SIGN_CLIENT_ID;
  const { server, port } = await startWebhookServer();
  const url = `http://127.0.0.1:${port}/api/esign/webhook/adobe-sign`;

  try {
    await test("an unconfigured endpoint refuses verification instead of looking healthy", async () => {
      delete process.env.ADOBE_SIGN_CLIENT_ID;
      const res = await fetch(url, { headers: { "X-AdobeSign-ClientId": "anything" } });
      assert.strictEqual(res.status, 503);
    });

    process.env.ADOBE_SIGN_CLIENT_ID = "client-id-abc123";

    await test("the registration probe echoes the client id in header and body", async () => {
      const res = await fetch(url, { headers: { "X-AdobeSign-ClientId": "client-id-abc123" } });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.headers.get("x-adobesign-clientid"), "client-id-abc123");
      const body = await res.json();
      assert.strictEqual(body.xAdobeSignClientId, "client-id-abc123");
    });

    await test("a missing client id is rejected", async () => {
      const res = await fetch(url);
      assert.strictEqual(res.status, 401);
    });

    await test("a wrong client id is rejected", async () => {
      const res = await fetch(url, { headers: { "X-AdobeSign-ClientId": "client-id-wrong99" } });
      assert.strictEqual(res.status, 401);
    });

    await test("a rejection leaks nothing about the expected client id", async () => {
      const res = await fetch(url, { headers: { "X-AdobeSign-ClientId": "nope" } });
      const text = await res.text();
      assert.ok(!text.includes("client-id-abc123"));
      assert.strictEqual(res.headers.get("x-adobesign-clientid"), null);
    });

    await test("a POST probe with an empty body is acknowledged", async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AdobeSign-ClientId": "client-id-abc123",
        },
        body: "{}",
      });
      assert.strictEqual(res.status, 200);
      const body = await res.json();
      assert.strictEqual(body.xAdobeSignClientId, "client-id-abc123");
    });

    await test("a dedicated webhook client id overrides the OAuth client id", async () => {
      process.env.ADOBE_SIGN_WEBHOOK_CLIENT_ID = "webhook-id-xyz789";
      try {
        const accepted = await fetch(url, {
          headers: { "X-AdobeSign-ClientId": "webhook-id-xyz789" },
        });
        assert.strictEqual(accepted.status, 200);

        // The OAuth client id must no longer be accepted once the dedicated
        // webhook id is set, or the override would widen what is trusted.
        const rejected = await fetch(url, {
          headers: { "X-AdobeSign-ClientId": "client-id-abc123" },
        });
        assert.strictEqual(rejected.status, 401);
      } finally {
        delete process.env.ADOBE_SIGN_WEBHOOK_CLIENT_ID;
      }
    });

    await test("an unauthenticated POST is rejected before any processing", async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "AGREEMENT_WORKFLOW_COMPLETED", agreement: { id: "X" } }),
      });
      assert.strictEqual(res.status, 401);
    });
  } finally {
    server.close();
    delete process.env.ADOBE_SIGN_WEBHOOK_CLIENT_ID;
    if (savedClientId) process.env.ADOBE_SIGN_CLIENT_ID = savedClientId;
    else delete process.env.ADOBE_SIGN_CLIENT_ID;
  }

  await test("client id comparison rejects a length mismatch", () => {
    assert.strictEqual(esignWebhook.safeEqual("abcdef", "abcde"), false);
    assert.strictEqual(esignWebhook.safeEqual("abcdef", "abcdef"), true);
    assert.strictEqual(esignWebhook.safeEqual("", ""), false);
    assert.strictEqual(esignWebhook.safeEqual(undefined, "abc"), false);
  });

  /* ---------------- notification parsing ---------------- */

  console.log("\nWebhook payload parsing");

  await test("a standard completion notification is parsed", () => {
    const parsed = esignWebhook.parseNotification({
      webhookNotificationId: "NOTIF-1",
      event: "AGREEMENT_WORKFLOW_COMPLETED",
      eventDate: "2026-08-09T15:04:05Z",
      agreement: {
        id: "AGREEMENT-123",
        status: "SIGNED",
        participantSetsInfo: [
          {
            status: "SIGNED",
            memberInfos: [
              {
                email: "Jane@Example.com",
                completedDate: "2026-08-09T15:03:00Z",
                lastViewedDate: "2026-08-09T14:00:00Z",
              },
            ],
          },
        ],
      },
    });
    assert.strictEqual(parsed.providerEventId, "NOTIF-1");
    assert.strictEqual(parsed.eventType, "AGREEMENT_WORKFLOW_COMPLETED");
    assert.strictEqual(parsed.agreementId, "AGREEMENT-123");
    assert.strictEqual(parsed.providerStatus, "SIGNED");
    assert.strictEqual(parsed.participants.length, 1);
    assert.ok(parsed.participants[0].signedAt instanceof Date);
  });

  await test("a payload with no participant detail still parses", () => {
    const parsed = esignWebhook.parseNotification({
      event: "AGREEMENT_EMAIL_VIEWED",
      agreement: { id: "AGREEMENT-9", status: "OUT_FOR_SIGNATURE" },
    });
    assert.strictEqual(parsed.agreementId, "AGREEMENT-9");
    assert.deepStrictEqual(parsed.participants, []);
  });

  await test("a decline reason is captured", () => {
    const parsed = esignWebhook.parseNotification({
      event: "AGREEMENT_REJECTED",
      agreement: {
        id: "AGREEMENT-9",
        status: "ABORTED",
        agreementRejectionInfo: { rejectionReason: "Price is wrong" },
      },
    });
    assert.strictEqual(parsed.declineReason, "Price is wrong");
  });

  await test("an empty payload does not throw", () => {
    const parsed = esignWebhook.parseNotification({});
    assert.strictEqual(parsed.agreementId, "");
    assert.ok(parsed.occurredAt instanceof Date);
  });

  /* ---------------- event application ---------------- */

  console.log("\nEvent application and idempotency");

  await test("a completion event marks the signature completed", async () => {
    const signature = fakeSignature();
    const result = await signatureService.applyEvent({
      signature,
      providerEventId: "NOTIF-1",
      eventType: "AGREEMENT_WORKFLOW_COMPLETED",
      normalizedEvent: "completed",
      providerStatus: "SIGNED",
      occurredAt: new Date("2026-08-09T15:04:05Z"),
    });
    assert.strictEqual(result.applied, true);
    assert.strictEqual(signature.status, "Completed");
    assert.strictEqual(signature.documentRetrieval.state, "pending");
  });

  await test("redelivering the same event changes nothing", async () => {
    const signature = fakeSignature();
    await signatureService.applyEvent({
      signature,
      providerEventId: "NOTIF-1",
      eventType: "AGREEMENT_WORKFLOW_COMPLETED",
      normalizedEvent: "completed",
      occurredAt: new Date("2026-08-09T15:04:05Z"),
    });
    const savesAfterFirst = signature.saveCount;

    const second = await signatureService.applyEvent({
      signature,
      providerEventId: "NOTIF-1",
      eventType: "AGREEMENT_WORKFLOW_COMPLETED",
      normalizedEvent: "completed",
      occurredAt: new Date("2026-08-09T16:00:00Z"),
    });

    assert.strictEqual(second.duplicated, true);
    assert.strictEqual(second.applied, false);
    assert.strictEqual(signature.processedEvents.length, 1);
    assert.strictEqual(signature.saveCount, savesAfterFirst);
  });

  await test("a late event cannot reopen a completed signature", async () => {
    const signature = fakeSignature({ status: "Completed" });
    await signatureService.applyEvent({
      signature,
      providerEventId: "NOTIF-LATE",
      eventType: "AGREEMENT_EMAIL_VIEWED",
      normalizedEvent: "viewed",
    });
    assert.strictEqual(signature.status, "Completed");
  });

  await test("a declined signature is not overwritten by a later completion", async () => {
    const signature = fakeSignature({ status: "Declined" });
    await signatureService.applyEvent({
      signature,
      providerEventId: "NOTIF-AFTER-DECLINE",
      eventType: "AGREEMENT_WORKFLOW_COMPLETED",
      normalizedEvent: "completed",
    });
    assert.strictEqual(signature.status, "Declined");
  });

  await test("a per-signer completion is partial, not full execution", async () => {
    const signature = fakeSignature();
    await signatureService.applyEvent({
      signature,
      providerEventId: "NOTIF-SIGNER",
      eventType: "AGREEMENT_ACTION_COMPLETED",
      normalizedEvent: "signer_completed",
    });
    assert.strictEqual(signature.status, "Partially Signed");
  });

  await test("signer progress is merged onto the matching signer", async () => {
    const signature = fakeSignature();
    await signatureService.applyEvent({
      signature,
      providerEventId: "NOTIF-VIEW",
      eventType: "AGREEMENT_EMAIL_VIEWED",
      normalizedEvent: "viewed",
      participants: [
        { email: "JANE@example.com", status: "ACTIVE", viewedAt: new Date("2026-08-09T14:00:00Z") },
      ],
    });
    assert.strictEqual(signature.status, "Viewed");
    assert.ok(signature.signers[0].viewedAt instanceof Date);
    assert.strictEqual(signature.signers[0].status, "ACTIVE");
  });

  await test("an unknown signer email is ignored rather than added", async () => {
    const signature = fakeSignature();
    await signatureService.applyEvent({
      signature,
      providerEventId: "NOTIF-STRANGER",
      eventType: "AGREEMENT_EMAIL_VIEWED",
      normalizedEvent: "viewed",
      participants: [{ email: "stranger@example.com", status: "ACTIVE" }],
    });
    assert.strictEqual(signature.signers.length, 1);
  });

  await test("an unrecognized event is recorded but changes no state", async () => {
    const signature = fakeSignature();
    await signatureService.applyEvent({
      signature,
      providerEventId: "NOTIF-UNKNOWN",
      eventType: "AGREEMENT_SOMETHING_ELSE",
      normalizedEvent: null,
    });
    assert.strictEqual(signature.status, "Sent");
    assert.strictEqual(signature.processedEvents.length, 1);
  });

  await test("a decline records the reason", async () => {
    const signature = fakeSignature();
    await signatureService.applyEvent({
      signature,
      providerEventId: "NOTIF-DECLINE",
      eventType: "AGREEMENT_REJECTED",
      normalizedEvent: "declined",
      declineReason: "Price is wrong",
    });
    assert.strictEqual(signature.status, "Declined");
    assert.strictEqual(signature.declineReason, "Price is wrong");
  });

  /* ---------------- document projection ---------------- */

  console.log("\nDocument status projection");

  await test("only a completed signature executes a change order", () => {
    const map = signatureService.CHANGE_ORDER_STATUS_FROM_SIGNATURE;
    assert.strictEqual(map.Completed, "Executed");
    for (const [signatureStatus, changeOrderStatus] of Object.entries(map)) {
      if (signatureStatus === "Completed") continue;
      assert.notStrictEqual(
        changeOrderStatus,
        "Executed",
        `${signatureStatus} must not execute a change order`
      );
    }
  });

  await test("cancelled and expired both void the change order", () => {
    const map = signatureService.CHANGE_ORDER_STATUS_FROM_SIGNATURE;
    assert.strictEqual(map.Cancelled, "Voided");
    assert.strictEqual(map.Expired, "Voided");
  });

  await test("a failed send has no change order status of its own", () =>
    assert.strictEqual(signatureService.CHANGE_ORDER_STATUS_FROM_SIGNATURE.Failed, undefined));

  await test("terminal statuses are exactly the four final outcomes", () =>
    assert.deepStrictEqual([...ESignature.TERMINAL_STATUSES], [
      "Completed",
      "Declined",
      "Cancelled",
      "Expired",
    ]));

  /* ---------------- summary ---------------- */

  console.log(`\n${passed} passed, ${failures.length} failed.`);
  if (failures.length) {
    for (const failure of failures) console.error(`\n${failure.name}\n${failure.err.stack}`);
    process.exit(1);
  }
  process.exit(0);
}

main();
