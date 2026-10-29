/** Every per-IP abuse limit (auth, free visit, tips, tracking, kiosk) keys on an IP that cannot be chosen by the client and is never our own load balancer (no database). */
const assert = require("assert");
const { clientIp } = require("../utils/auth/clientIp");
const req = (xff, remote) => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: remote } });
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  PASS  ${name}`); };
t("behind ALB + nginx: the address the load balancer appended", () => assert.strictEqual(clientIp(req("203.0.113.9, 10.0.1.5", "127.0.0.1")), "203.0.113.9"));
t("a forged header cannot change the key", () => assert.strictEqual(clientIp(req("1.2.3.4, 5.6.7.8, 203.0.113.9, 10.0.1.5", "127.0.0.1")), "203.0.113.9"));
t("garbage in the header is ignored", () => assert.strictEqual(clientIp(req("evil<script>, 203.0.113.9", "10.0.0.2")), "203.0.113.9"));
t("direct connection without a header", () => assert.strictEqual(clientIp(req("", "::ffff:198.51.100.7")), "198.51.100.7"));
t("local development falls back to the socket", () => assert.strictEqual(clientIp(req("", "127.0.0.1")), "127.0.0.1"));
t("two customers behind the same load balancer get different keys", () => assert.notStrictEqual(clientIp(req("203.0.113.9, 10.0.1.5", "127.0.0.1")), clientIp(req("198.51.100.20, 10.0.1.5", "127.0.0.1"))));
console.log(`\n${n} passed`);
