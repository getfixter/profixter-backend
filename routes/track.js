const express = require("express");
const { clientIp } = require("../utils/auth/clientIp");
const jwt = require("jsonwebtoken");
const router = express.Router();
const User = require("../models/User");
const metaCapi = require("../utils/metaCapi");
const SiteVisitor = require("../models/SiteVisitor");
const { classifySource, ACQUISITION_REF_SOURCES } = require("../utils/analytics/attribution");
const { rateLimit, consume } = require("../utils/rateLimit");

/**
 * Who is calling, if anybody - and never a refusal.
 *
 * The shared auth middleware answers 401 when there is no token, which is
 * correct everywhere it is used and wrong here: a conversion can happen before
 * an account exists, and an anonymous event matched on cookies alone is worth
 * more than no event. So a token is decoded when present and ignored when it
 * is absent, expired or malformed.
 *
 * It deliberately does not load the user. The handler decides whether it needs
 * the record, so a relay call that ends up rejected by the allow-list costs no
 * database read at all.
 */
async function optionalAuth(req, _res, next) {
  try {
    const bearer = req.header("Authorization");
    const token = (bearer && bearer.replace(/^Bearer\s+/i, "")) || req.header("x-auth-token");
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      if (decoded?.id) req.user = { _id: decoded.id };
    }
  } catch {
    /* An unreadable token is simply an anonymous caller. */
  }
  next();
}

/**
 * The legacy /fbcap relay, kept reachable but repointed.
 *
 * It had its own copy of the pixel id from FB_PIXEL_ID, its own API version,
 * and no caller anywhere in the frontend. The id is what mattered: a stale env
 * var here meant conversions landing in the old dataset. It now forwards to the
 * single sender, which names the dataset in code and hashes what Meta needs.
 *
 * Kept rather than deleted because it is publicly mounted and something we
 * cannot see from this repo - a custom GTM tag, the agency's own tooling -
 * may still be posting to it. Use POST /api/track/meta for anything new.
 */
let retiredRelayLoggedAt = {};
function noteRetiredRelay(path) {
  const now = Date.now();
  if (now - (retiredRelayLoggedAt[path] || 0) < 60 * 60 * 1000) return;
  retiredRelayLoggedAt[path] = now;
  console.log(JSON.stringify({ event: "meta_relay_retired_called", path }));
}
router.post("/fbcap", (req, res) => {
  /*
   * Retired 2026-11-03. It forwarded whatever the body said - the event, the
   * value, even the email and phone - to Meta, so anybody could inject fake
   * Purchases into the dataset. Nothing on the site or in GTM posts here. It
   * still answers 200 so an unseen caller does not start retrying, and the
   * first call per hour is logged so such a caller can be found.
   */
  noteRetiredRelay("/api/track/fbcap");
  return res.status(200).json({ ok: true });
});

// Confirmation page fetches real plan/value using token (?t=...)
router.get("/last-purchase", async (req, res) => {
  try {
    const t = String(req.query.t || "");
    if (!t) return res.status(400).json({ ok: false });

    const user = await User.findOne({ "lastPurchase.token": t }).select("lastPurchase");
    if (!user || !user.lastPurchase) return res.status(404).json({ ok: false });

    return res.json({
      ok: true,
      plan: user.lastPurchase.plan,
      value: user.lastPurchase.value,
      currency: user.lastPurchase.currency,
      createdAt: user.lastPurchase.createdAt,
      /*
       * The id the Stripe webhook used when it reported this to Meta.
       *
       * Without it the confirmation page would mint its own, and Meta would
       * count the same membership twice - once from the browser and once from
       * the server - because deduplication is by event_id and nothing else.
       */
      eventId: user.lastPurchase.eventId || null,
      billingCycle: user.lastPurchase.billingCycle || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});

router.get("/last-purchase-by-session", async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || "");
    if (!sessionId) return res.status(400).json({ ok: false });

    const user = await User.findOne({ "lastPurchase.stripeSessionId": sessionId }).select("lastPurchase");
    if (!user || !user.lastPurchase) return res.status(404).json({ ok: false });

    return res.json({
      ok: true,
      plan: user.lastPurchase.plan,
      value: user.lastPurchase.value,
      currency: user.lastPurchase.currency,
      createdAt: user.lastPurchase.createdAt,
      /*
       * The id the Stripe webhook used when it reported this to Meta.
       *
       * Without it the confirmation page would mint its own, and Meta would
       * count the same membership twice - once from the browser and once from
       * the server - because deduplication is by event_id and nothing else.
       */
      eventId: user.lastPurchase.eventId || null,
      billingCycle: user.lastPurchase.billingCycle || null,
    });
  } catch (e) {
    return res.status(500).json({ ok: false });
  }
});


/**
 * The browser handing an event to the server so it can reach Meta a second way.
 *
 * Used only for conversions the server does not already know about by itself.
 * Registration and Stripe both report their own events from the handler that
 * owns the truth, with better identifiers than a page has; this endpoint exists
 * for the cases in between - a free visit booked from a screen we have not
 * given a server-side hook.
 *
 * ALWAYS 204, WHATEVER HAPPENS. The caller is a fire-and-forget fetch on a
 * conversion path. There is no failure it could usefully act on, and an error
 * status would only produce noise in a console the customer might have open.
 */
// Per browser IP; over the limit the event is simply not forwarded (still 204).
const RELAY_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };
// The only descriptive fields a relayed event may carry. Never value or currency:
// a page must not be able to say how much something was worth.
const RELAY_CUSTOM_KEYS = ["content_name", "content_category", "content_type", "lead_type", "visit_type", "source"];

router.post("/meta", optionalAuth, async (req, res) => {
  try {
    const ip = clientIp(req);
    if (ip && !consume({ key: `meta-relay:${ip}`, ...RELAY_LIMIT }).allowed) return res.status(204).end();
    const {
      eventName,
      eventId,
      eventSourceUrl,
      customData = {},
      fbp,
      fbc,
      attribution = {},
    } = req.body || {};

    /*
     * Only the conversions we actually optimise for.
     *
     * An open relay to the Conversions API is an open relay: anybody could post
     * arbitrary event names into the dataset and quietly poison the ad
     * account's optimisation. The allow-list is the whole defence.
     *
     * Schedule is the free first visit being booked. It used to be sent as a
     * second Lead, so a cold visitor who signed up and booked counted as two
     * leads; account creation is now the only Lead.
     *
     * 2026-11-03: Subscribe and Purchase are no longer relayed. The Stripe
     * webhook reports every paid one itself, with the amount Stripe charged,
     * so a relayed copy could only ever be a duplicate - or a forgery.
     */
    const ALLOWED = new Set(["Lead", "Schedule"]);
    if (!eventName || !ALLOWED.has(String(eventName))) {
      return res.status(204).end();
    }

    /*
     * Identity comes from the session, never from the request body.
     *
     * The browser may send fbp and fbc, which are opaque and harmless. It may
     * not tell us who it is - that would let anybody attribute a conversion to
     * any email they like. So the email, phone, name and address are read from
     * the authenticated user, and an anonymous caller simply sends an event
     * matched on cookies alone.
     */
    let user = null;
    if (req.user?._id) {
      user = await User.findById(req.user._id).select(
        "email phone firstName lastName name userId addresses city state zip attribution"
      );
    }

    const primary =
      (user?.addresses || []).find((a) => String(a._id) === String(user?.defaultAddressId)) ||
      (user?.addresses || [])[0] ||
      null;

    await metaCapi.send({
      eventName: String(eventName),
      eventId: eventId ? String(eventId) : undefined,
      eventSourceUrl: eventSourceUrl || req.headers.referer,
      customData: Object.fromEntries(
        RELAY_CUSTOM_KEYS.filter((k) => typeof customData?.[k] === "string").map((k) => [k, customData[k].slice(0, 100)])
      ),
      user: user
        ? {
            email: user.email,
            phone: user.phone,
            firstName: user.firstName,
            lastName: user.lastName,
            name: user.name,
          }
        : {},
      address: {
        city: primary?.city || user?.city,
        state: primary?.state || user?.state,
        zip: primary?.zip || user?.zip,
      },
      externalId: user ? user.userId || String(user._id) : undefined,
      fbp,
      fbc,
      fbclid: attribution?.fbclid || user?.attribution?.fbclid,
      fbclidAt: attribution?.fbclidAt,
      req,
    });
  } catch (error) {
    console.warn("Meta relay failed:", error.message);
  }

  return res.status(204).end();
});

/**
 * First sight of an anonymous browser: the top of the Overview funnel.
 *
 * Public by necessity (it fires before anyone has an account), so it accepts
 * only a random id and URL facts, stores no IP or user agent, ignores obvious
 * bots, and is insert-only: repeating it changes nothing. Always 204.
 */
const visitLimiter = rateLimit({
  limit: 20,
  windowMs: 10 * 60 * 1000,
  keyResolver: (req) => clientIp(req) || null,
});
const BOT_UA = /bot|crawl|spider|slurp|headless|lighthouse|preview|facebookexternalhit|pingdom|monitor/i;

/**
 * One step of the booking funnel (see models/FunnelStep). Public and always
 * 204, like /visit: a random browser id and a step name, nothing personal.
 * Counted once per browser, step and New York day, under the browser's
 * first-touch source when it has one.
 */
const stepLimiter = rateLimit({
  limit: 60,
  windowMs: 10 * 60 * 1000,
  keyResolver: (req) => clientIp(req) || null,
});

router.post("/step", stepLimiter, async (req, res) => {
  try {
    const { FunnelStep, FunnelStepSeen, STEPS } = require("../models/FunnelStep");
    const visitorId = String(req.body?.visitorId || "");
    const step = String(req.body?.step || "");
    if (!/^[A-Za-z0-9_-]{12,64}$/.test(visitorId) || !STEPS.includes(step) || BOT_UA.test(String(req.headers["user-agent"] || ""))) {
      return res.status(204).end();
    }
    const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    try {
      await FunnelStepSeen.create({ key: `${visitorId}|${step}|${date}`, expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) });
    } catch (error) {
      if (error?.code === 11000) return res.status(204).end(); // already counted today
      throw error;
    }
    const visitor = await SiteVisitor.findOne({ visitorId }).select("source").lean();
    await FunnelStep.updateOne({ date, step, source: visitor?.source || "direct" }, { $inc: { count: 1 } }, { upsert: true });
  } catch (error) {
    console.warn("Funnel step failed:", error.message);
  }
  return res.status(204).end();
});

/**
 * The Google review link was opened (profixter.com/review, models/ReviewLinkClick).
 *
 * Sent as text/plain so the browser fires it without a preflight while the
 * page is already leaving for Google. Public and always 204, like /step: a
 * random browser id (only to count a browser once a day) and where the link
 * was. Nothing personal is stored, and bots are ignored.
 */
const reviewOpenLimiter = rateLimit({
  limit: 20,
  windowMs: 10 * 60 * 1000,
  keyResolver: (req) => clientIp(req) || null,
});

router.post("/review-open", express.text({ type: "text/plain", limit: "1kb" }), reviewOpenLimiter, async (req, res) => {
  try {
    const ReviewLinkClick = require("../models/ReviewLinkClick");
    const { FunnelStepSeen } = require("../models/FunnelStep");
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        body = {};
      }
    }
    const visitorId = String(body?.visitorId || "");
    const via = ReviewLinkClick.VIAS.includes(String(body?.via || "")) ? String(body.via) : "other";
    if (!/^[A-Za-z0-9_-]{12,64}$/.test(visitorId) || BOT_UA.test(String(req.headers["user-agent"] || ""))) {
      return res.status(204).end();
    }
    const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    try {
      await FunnelStepSeen.create({ key: `${visitorId}|review:${via}|${date}`, expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000) });
    } catch (error) {
      if (error?.code === 11000) return res.status(204).end(); // already counted today
      throw error;
    }
    await ReviewLinkClick.updateOne({ date, via }, { $inc: { count: 1 } }, { upsert: true });
  } catch (error) {
    console.warn("Review link open failed:", error.message);
  }
  return res.status(204).end();
});

router.post("/visit", visitLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const visitorId = String(body.visitorId || "");
    if (!/^[A-Za-z0-9_-]{12,64}$/.test(visitorId) || BOT_UA.test(String(req.headers["user-agent"] || ""))) {
      return res.status(204).end();
    }
    const clip = (v, n = 200) => (v === undefined || v === null || v === "" ? null : String(v).slice(0, n));
    let referrerHost = null;
    try {
      referrerHost = body.referrer ? new URL(String(body.referrer)).hostname.replace(/^www\./, "").slice(0, 120) : null;
    } catch {
      referrerHost = null;
    }
    const doc = {
      visitorId,
      firstSeenAt: new Date(),
      landingPath: clip(body.landingPath),
      referrerHost,
      utmSource: clip(body.utmSource),
      utmMedium: clip(body.utmMedium),
      utmCampaign: clip(body.utmCampaign),
      utmContent: clip(body.utmContent),
      utmTerm: clip(body.utmTerm),
      campaignId: clip(body.campaignId, 64),
      campaignName: clip(body.campaignName),
      adsetId: clip(body.adsetId, 64),
      adsetName: clip(body.adsetName),
      adId: clip(body.adId, 64),
      adName: clip(body.adName),
      // Only our acquisition tags; an internal button's ?source= is navigation, not how they found us.
      refSource: ACQUISITION_REF_SOURCES.has(String(body.refSource || "").toLowerCase()) ? String(body.refSource).toLowerCase() : null,
      refCode: clip(body.refCode, 64),
      hasFbclid: !!body.fbclid,
      hasGclid: !!(body.gclid || body.gbraid || body.wbraid),
    };
    doc.source = classifySource({
      ...doc,
      fbclid: doc.hasFbclid ? "1" : null,
      gclid: doc.hasGclid ? "1" : null,
      referrer: referrerHost ? `https://${referrerHost}/` : null,
    }).key;
    await SiteVisitor.updateOne({ visitorId }, { $setOnInsert: doc }, { upsert: true });
  } catch (error) {
    if (error?.code !== 11000) console.warn("Visit record failed:", error.message);
  }
  return res.status(204).end();
});

module.exports = router;
