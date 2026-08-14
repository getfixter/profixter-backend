/**
 * Unsubscribe tokens, including the backward compatibility that matters most.
 *
 * These links live in customers' inboxes for a year. The marketing work
 * introduced a dedicated EMAIL_UNSUBSCRIBE_SECRET so that rotating JWT_SECRET
 * cannot silently turn every outstanding opt-out link into a 400 page, and the
 * one thing that must never regress is that tokens minted BEFORE the dedicated
 * secret existed still open afterwards.
 *
 * The older admin campaign system mints tokens through the same helper, so this
 * covers that too.
 *
 *   node scripts/test_unsubscribe_token.js
 */

const assert = require("assert");
const path = require("path");

const MODULE = path.join(__dirname, "..", "utils", "unsubscribeToken.js");

/** Reload the module so it re-reads the environment. */
function load() {
  delete require.cache[require.resolve(MODULE)];
  return require(MODULE);
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    failures.push({ name, message: error?.message || String(error) });
  }
}

const LEGACY = "legacy-jwt-secret-value";
const DEDICATED = "dedicated-unsubscribe-secret-value";

test("a token round trips", () => {
  withEnv({ JWT_SECRET: LEGACY, EMAIL_UNSUBSCRIBE_SECRET: DEDICATED }, () => {
    const { createUnsubscribeToken, readUnsubscribeToken } = load();
    const token = createUnsubscribeToken("Dana@Example.COM");
    assert.strictEqual(readUnsubscribeToken(token).email, "dana@example.com",
      "the address should come back normalised");
  });
});

test("a token minted before the dedicated secret existed still opens", () => {
  // Mint with JWT_SECRET only, the way every link already in the wild was made.
  const legacyToken = withEnv({ JWT_SECRET: LEGACY, EMAIL_UNSUBSCRIBE_SECRET: undefined }, () => {
    const { createUnsubscribeToken } = load();
    return createUnsubscribeToken("old@customer.net");
  });

  // Now the dedicated secret is introduced. The old link must keep working.
  withEnv({ JWT_SECRET: LEGACY, EMAIL_UNSUBSCRIBE_SECRET: DEDICATED }, () => {
    const { readUnsubscribeToken } = load();
    assert.strictEqual(readUnsubscribeToken(legacyToken).email, "old@customer.net",
      "an outstanding unsubscribe link broke when the dedicated secret was added");
  });
});

test("new tokens are signed with the dedicated secret, not the login secret", () => {
  const token = withEnv({ JWT_SECRET: LEGACY, EMAIL_UNSUBSCRIBE_SECRET: DEDICATED }, () => {
    const { createUnsubscribeToken } = load();
    return createUnsubscribeToken("new@customer.net");
  });

  // Rotating JWT_SECRET must not affect a token minted with the dedicated one.
  withEnv({ JWT_SECRET: "rotated-completely-different", EMAIL_UNSUBSCRIBE_SECRET: DEDICATED }, () => {
    const { readUnsubscribeToken } = load();
    assert.strictEqual(readUnsubscribeToken(token).email, "new@customer.net",
      "rotating the login secret invalidated a marketing unsubscribe link");
  });
});

test("a token is rejected once neither secret can open it", () => {
  const token = withEnv({ JWT_SECRET: LEGACY, EMAIL_UNSUBSCRIBE_SECRET: undefined }, () => {
    const { createUnsubscribeToken } = load();
    return createUnsubscribeToken("someone@customer.net");
  });
  withEnv({ JWT_SECRET: "a-different-secret", EMAIL_UNSUBSCRIBE_SECRET: "also-different" }, () => {
    const { readUnsubscribeToken } = load();
    assert.throws(() => readUnsubscribeToken(token), /Invalid unsubscribe token/);
  });
});

test("a tampered token is rejected rather than unsubscribing the wrong person", () => {
  withEnv({ JWT_SECRET: LEGACY, EMAIL_UNSUBSCRIBE_SECRET: DEDICATED }, () => {
    const { createUnsubscribeToken, readUnsubscribeToken } = load();
    const token = createUnsubscribeToken("victim@customer.net");
    const bytes = Buffer.from(token, "base64url");
    bytes[bytes.length - 1] ^= 0xff;
    assert.throws(() => readUnsubscribeToken(bytes.toString("base64url")));
  });
});

test("junk input is rejected", () => {
  withEnv({ JWT_SECRET: LEGACY, EMAIL_UNSUBSCRIBE_SECRET: DEDICATED }, () => {
    const { readUnsubscribeToken } = load();
    for (const junk of ["", "abc", "!!!!", null, undefined]) {
      assert.throws(() => readUnsubscribeToken(junk), `accepted ${JSON.stringify(junk)}`);
    }
  });
});

test("an expired token is rejected", () => {
  withEnv({ JWT_SECRET: LEGACY, EMAIL_UNSUBSCRIBE_SECRET: DEDICATED }, () => {
    const crypto = require("crypto");
    const key = crypto.createHash("sha256").update(DEDICATED).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const payload = JSON.stringify({ email: "old@customer.net", expiresAt: Date.now() - 1000 });
    const body = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    const token = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");

    const { readUnsubscribeToken } = load();
    assert.throws(() => readUnsubscribeToken(token), /Expired unsubscribe token/);
  });
});

test("the token carries no readable address", () => {
  withEnv({ JWT_SECRET: LEGACY, EMAIL_UNSUBSCRIBE_SECRET: DEDICATED }, () => {
    const { createUnsubscribeToken } = load();
    const token = createUnsubscribeToken("dana@customer.net");
    assert.ok(!token.includes("dana"), "the address is visible in the token");
    assert.ok(!Buffer.from(token, "base64url").toString("utf8").includes("customer.net"));
  });
});

test("a missing secret is an error, never a silent fallback", () => {
  withEnv({ JWT_SECRET: undefined, EMAIL_UNSUBSCRIBE_SECRET: undefined }, () => {
    const { createUnsubscribeToken } = load();
    assert.throws(() => createUnsubscribeToken("a@b.com"), /required/);
  });
});

console.log(`\nunsubscribe token: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL  ${f.name}\n        ${f.message}`);
  process.exit(1);
}
process.exit(0);
