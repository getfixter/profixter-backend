/**
 * Tips for Fixters, from the completion email through to the ledger.
 *
 * WHAT CHANGED AND WHY
 * Tipping used to be a single static Stripe Payment Link. Every customer, every
 * visit and every Fixter shared one URL, so a tip arrived as an anonymous
 * payment with nothing tying it to the person who earned it. Attribution was
 * not hard, it was impossible. The flow now runs through this server:
 *
 *   completion email -> /tip?t=<opaque token> -> Checkout Session we created
 *   -> Stripe -> verified webhook -> Tip record -> notification and totals
 *
 * THE RULES THAT MATTER
 *
 * 1. The browser never chooses who gets paid. The link carries a token this
 *    server issued and can decrypt (utils/tipToken); the Fixter is looked up
 *    and re-validated here, on both the create and the record paths.
 *
 * 2. Attribution is recorded or it is absent. There is no guessing. A tip
 *    whose context cannot be resolved is stored unassigned and shown to the
 *    admin to place by hand. Crediting the likely Fixter would be a bookkeeping
 *    error that looks exactly like a correct entry.
 *
 *    One narrow, labelled exception: a tip paid through the OLD static Stripe
 *    link (which still exists and was still behind My Visits' "Leave a tip"
 *    until 2026-11-27) carries no context at all. It is credited only when the
 *    payer is a Profixter customer by a usable account email AND every visit
 *    that customer had completed in the 30 days before the tip was done by one
 *    and the same Fixter (attributionFromVisitHistory). Anything less stays
 *    unassigned and flagged for review. The record says so
 *    (attributionBasis "visit_history"), so it never looks like a token match.
 *
 * 3. A failed page is lost money. Every failure to resolve context degrades to
 *    an unattributed tip rather than an error, because a customer with their
 *    card out and a broken page is worse than a tip that needs assigning later.
 *
 * 4. The customer experience stays what it was. One click from the email, then
 *    Stripe Checkout with a free-entry amount - the same custom-amount price
 *    behaviour the Payment Link had, not a form of our own.
 *
 * Everything except the two Stripe calls is a pure function, so the rules are
 * testable without a network, a database or money.
 */

const { stripe, hasStripeSecretKey } = require("./subscriptionManagement");
const {
  createFixterChoiceToken,
  createTipToken,
  tipTokensAvailable,
} = require("./tipToken");
const { tipPageUrl } = require("./tipPage");

/** Marks our Checkout Sessions, exactly as the one-time visit flow does. */
const FIXTER_TIP_PRODUCT_KIND = "fixter_tip";

/** Positions that can receive a tip. Anything else is not a Fixter. */
const TIPPABLE_POSITIONS = Object.freeze(["Fixter", "General Fixter"]);

/**
 * Stripe's own floor for a card charge is 50 cents; a dollar is the friendlier
 * one. The ceiling is deliberately far above any real tip: it exists to catch a
 * mistyped amount, not to tell a generous customer no.
 */
const TIP_MIN_CENTS = 100;
const TIP_MAX_CENTS = 200000;

/**
 * What the amount box starts at.
 *
 * A suggestion, not a price. Stripe pre-fills the field and the customer types
 * over it, so this is the difference between a box reading $0.00 and one
 * reading $20.00 - it never restricts what can be paid, and the free-entry
 * behaviour either side of it is untouched.
 */
const TIP_PRESET_CENTS = 2000;

/**
 * The reusable custom-amount Price behind every tip.
 *
 * Checkout Sessions cannot declare a customer-chosen amount inline: only a
 * Price carries custom_unit_amount. One shared Price gives the Payment Link's
 * free-entry box back, while the session around it carries the attribution.
 *
 * WHY THE KEY CARRIES A VERSION
 * custom_unit_amount is fixed at creation: Stripe's price update accepts
 * active, metadata, nickname, lookup_key and tax_behavior, and nothing that
 * would let the amount configuration be edited. Changing the preset therefore
 * means provisioning a new Price, and the version in the key is what makes that
 * happen by itself on deploy rather than needing anyone in the dashboard. The
 * superseded price is simply no longer referenced.
 */
const TIP_PRICE_LOOKUP_KEY = "profixter_fixter_tip_usd_v2";

/**
 * How long one tip attempt reuses the same Checkout Session.
 *
 * A refresh, a back button or a double click inside this window resolves to the
 * same session rather than a second one. Beyond it a genuinely new tip for the
 * same visit is allowed through, because refusing a customer who wants to tip
 * twice would be the wrong failure. Two Tip records can never come from one
 * payment regardless: that is guaranteed by the PaymentIntent index.
 *
 * Only ever applied to a tip scoped to a booking. See createTipCheckoutSession.
 */
const TIP_SESSION_WINDOW_MS = 60 * 60 * 1000;

const TIME_ZONE = "America/New_York";

/**
 * The old static Stripe tip Payment Link ("Tip Mr. Fixter",
 * buy.stripe.com/eVq8wO3W98O03NL3ASawo00). Still active in Stripe, because it
 * is printed and bookmarked in places this code cannot see, so its sessions are
 * recognised as tips by the link they came through - never by their amount.
 * A code default on purpose: the EB environment is at its size limit.
 * STRIPE_LEGACY_TIP_PAYMENT_LINKS (comma separated) replaces the list.
 */
const DEFAULT_LEGACY_TIP_PAYMENT_LINK_IDS = Object.freeze(["plink_1RycuaBw0RtvSZjMIGYLnCpD"]);

function legacyTipPaymentLinkIds() {
  const configured = String(process.env.STRIPE_LEGACY_TIP_PAYMENT_LINKS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return configured.length ? configured : [...DEFAULT_LEGACY_TIP_PAYMENT_LINK_IDS];
}

/**
 * When the website's tip ledger began recording (first Tip record:
 * 2026-08-12 18:01 UTC). Tips paid before this never had a website record to
 * go missing from; they are Stripe-only history, and reconciliation and repair
 * do not reach behind it unless explicitly told to.
 */
const TIP_LEDGER_STARTED_AT = new Date("2026-08-12T18:00:00Z");

/** How far back an old-link tip looks for the visits it could be for. */
const VISIT_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** A visit completed this close before the tip is the visit it is linked to. */
const SAME_VISIT_WINDOW_MS = 24 * 60 * 60 * 1000;

let cachedTipPriceId = null;

function toCents(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : 0;
}

function cleanText(value, max = 240) {
  return String(value ?? "").trim().slice(0, max);
}

function cleanEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

/**
 * A hex id from whatever shape the caller happened to have.
 *
 * The ObjectId check comes first on purpose: `id` on a Mongo ObjectId is the
 * raw twelve byte buffer, not the hex string everything else means by "id", so
 * reading `.id` first would put binary into Stripe metadata and into the tip
 * link. Stripe objects are the ones that carry a string `id`.
 */
function idString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value.toHexString === "function") return value.toHexString();
  if (typeof value.id === "string" && value.id) return value.id;
  if (value._id) return idString(value._id);

  const text = String(value);
  return text && text !== "null" && text !== "undefined" ? text : "";
}

function firstName(fullName) {
  return cleanText(fullName, 160).split(/\s+/)[0] || "";
}

/* ------------------------------------------------------------------ */
/* Who may be tipped                                                   */
/* ------------------------------------------------------------------ */

/**
 * Whether this user record can receive a tip.
 *
 * Checked when the session is created and again when the payment is recorded,
 * because the two happen minutes apart and an employee can be edited in
 * between. Deliberately does not require isActive: a Fixter who has since left
 * still earned the money, and refusing to credit them would misstate the books.
 */
function isEligibleFixter(user) {
  if (!user) return false;
  if (String(user.role || "") !== "employee") return false;
  return TIPPABLE_POSITIONS.includes(String(user.employeePosition || ""));
}

/**
 * Whether this Fixter may be offered to a customer to tip right now.
 *
 * Eligibility plus currently active, and the difference between the two is
 * deliberate. isEligibleFixter decides who may be CREDITED, and does not check
 * isActive, because someone who has since left still earned the tips they were
 * paid. This decides who may be CHOSEN, and does check it: a customer must not
 * be offered somebody who no longer works here.
 */
function isSelectableFixter(user) {
  return isEligibleFixter(user) && user.isActive !== false;
}

/**
 * What a customer standing on the public tip page is allowed to see.
 *
 * A first name and an opaque handle. Nothing else leaves the building: no
 * database id, no email, no phone, no position, no availability, no earnings,
 * no employment status. The handle is an encrypted choice token, so the page
 * cannot read who it refers to and cannot invent one for somebody we did not
 * offer.
 */
function publicFixterDTO(user) {
  const first =
    cleanText(user?.firstName, 60) ||
    cleanText(user?.name, 60).split(/\s+/)[0] ||
    "Fixter";
  return { choice: createFixterChoiceToken(idString(user?._id)), firstName: first };
}

/** The chooser list: selectable Fixters only, in a stable, friendly order. */
function publicFixterList(users = []) {
  return users
    .filter(isSelectableFixter)
    .map(publicFixterDTO)
    .sort((left, right) => left.firstName.localeCompare(right.firstName));
}

/* ------------------------------------------------------------------ */
/* The link in the completion email                                    */
/* ------------------------------------------------------------------ */

/**
 * The tip URL for one completed booking.
 *
 * Falls back to the bare page whenever a token cannot be issued: a customer who
 * still reaches Stripe and leaves an unassigned tip is a bookkeeping task, a
 * customer who reaches a dead link is lost revenue.
 */
function tipUrlForBooking(booking) {
  const page = tipPageUrl();
  if (!booking || !tipTokensAvailable()) return page;

  const fixterId = idString(booking.assignedFixterId);
  const bookingId = idString(booking._id);
  if (!fixterId && !bookingId) return page;

  try {
    const token = createTipToken({
      bookingId,
      fixterId,
      userId: idString(booking.user),
    });
    return `${page}?t=${encodeURIComponent(token)}`;
  } catch {
    return page;
  }
}

/* ------------------------------------------------------------------ */
/* Creating the Checkout Session                                       */
/* ------------------------------------------------------------------ */

function isFixterTipCheckoutSession(session) {
  return (
    String(session?.mode || "").toLowerCase() === "payment" &&
    session?.metadata?.productKind === FIXTER_TIP_PRODUCT_KIND
  );
}

/** A session from the old static tip link. Identified by the link, never by the amount. */
function isLegacyTipPaymentLinkSession(session) {
  if (String(session?.mode || "").toLowerCase() !== "payment") return false;
  const link = idString(session?.payment_link);
  return !!link && legacyTipPaymentLinkIds().includes(link);
}

/** Either tip flow. This is the definition of "a tip" everywhere money is reconciled. */
function isTipCheckoutSession(session) {
  return isFixterTipCheckoutSession(session) || isLegacyTipPaymentLinkSession(session);
}

/**
 * Identifiers only. No names, no email addresses, no amounts.
 *
 * The booking rides along even when no Fixter could be validated. It is not
 * attribution - nothing is credited on the strength of it - but it is the
 * evidence an admin needs to place the tip by hand afterwards, and throwing it
 * away would make the unassigned list harder to clear for no gain.
 */
function tipCheckoutMetadata({ fixterId, bookingId, userId }) {
  const booking = idString(bookingId);
  return {
    productKind: FIXTER_TIP_PRODUCT_KIND,
    fixterId: idString(fixterId),
    bookingId: booking,
    userId: idString(userId),
    source: booking ? "completion_email" : "direct",
  };
}

/**
 * Stable within one attempt window, distinct between real attempts.
 * See TIP_SESSION_WINDOW_MS for the reasoning.
 */
function tipIdempotencyKey({ fixterId, bookingId, now = Date.now(), windowMs = TIP_SESSION_WINDOW_MS }) {
  const window = Math.floor(Number(now) / windowMs);
  return `pfx-tip-${idString(bookingId) || "none"}-${idString(fixterId) || "none"}-${window}`;
}

/**
 * The Price customers choose an amount on.
 *
 * Resolved from the environment first, then by lookup key, and only created
 * when neither exists, so a deployment never depends on someone having clicked
 * through the Stripe dashboard. The lookup key is unique in Stripe, which makes
 * the create idempotent in practice; a lost race re-reads instead of failing.
 */
async function ensureTipPriceId() {
  const configured = String(process.env.STRIPE_TIP_PRICE_ID || "").trim();
  if (configured) return configured;
  if (cachedTipPriceId) return cachedTipPriceId;

  const existing = await stripe.prices.list({
    lookup_keys: [TIP_PRICE_LOOKUP_KEY],
    active: true,
    limit: 1,
  });
  if (existing?.data?.[0]?.id) {
    cachedTipPriceId = existing.data[0].id;
    return cachedTipPriceId;
  }

  try {
    const created = await stripe.prices.create(
      {
        currency: "usd",
        lookup_key: TIP_PRICE_LOOKUP_KEY,
        nickname: "Fixter tip - customer chooses the amount",
        custom_unit_amount: {
          // enabled keeps the amount the customer's to type. preset only
          // decides what is already in the box when they get there.
          enabled: true,
          minimum: TIP_MIN_CENTS,
          maximum: TIP_MAX_CENTS,
          preset: TIP_PRESET_CENTS,
        },
        product_data: { name: "Tip for your Fixter" },
        metadata: { source: FIXTER_TIP_PRODUCT_KIND },
      },
      { idempotencyKey: `pfx-tip-price-${TIP_PRICE_LOOKUP_KEY}` }
    );
    cachedTipPriceId = created.id;
    return cachedTipPriceId;
  } catch (error) {
    const retry = await stripe.prices.list({
      lookup_keys: [TIP_PRICE_LOOKUP_KEY],
      active: true,
      limit: 1,
    });
    if (retry?.data?.[0]?.id) {
      cachedTipPriceId = retry.data[0].id;
      return cachedTipPriceId;
    }
    throw error;
  }
}

function clientUrl() {
  return String(process.env.CLIENT_URL || "https://www.profixter.com").replace(/\/+$/, "");
}

/**
 * Everything Stripe is told about one tip.
 *
 * Kept pure and separate from the call so a test can assert on the payload -
 * that the amount is the customer's to choose, that attribution rides in
 * metadata, and that no personal data is sent that Stripe does not need.
 */
function buildTipCheckoutParams({ priceId, fixter, bookingId, userId, prefillEmail }) {
  const name = firstName(fixter?.name) || cleanText(fixter?.firstName, 160);
  const metadata = tipCheckoutMetadata({
    fixterId: idString(fixter?._id),
    bookingId,
    userId,
  });
  const base = clientUrl();

  const params = {
    mode: "payment",
    // "pay", not "donate". A tip goes to a person for work done; labelling the
    // button Donate would imply a charitable gift, which this is not.
    submit_type: "pay",
    line_items: [{ price: priceId, quantity: 1 }],
    metadata,
    payment_intent_data: {
      description: name ? `Tip for ${name}` : "Tip for the Profixter team",
      metadata,
    },
    custom_text: {
      submit: {
        message: name
          ? `Your tip goes to ${name}. Thank you for looking after the people who look after your home.`
          : "Thank you for looking after the people who look after your home.",
      },
    },
    success_url: `${base}/tip/thank-you?status=complete`,
    cancel_url: `${base}/tip/thank-you?status=canceled`,
  };

  const email = cleanEmail(prefillEmail);
  if (email) params.customer_email = email;

  return params;
}

/**
 * Open a tip checkout. Returns the URL to send the customer to.
 *
 * `attributed` says whether a Fixter was resolved. The caller does not branch
 * on it: an unattributed tip goes through the identical flow and lands in the
 * admin's unassigned list.
 */
async function createTipCheckoutSession({
  fixter = null,
  bookingId = "",
  userId = "",
  prefillEmail = "",
  now = Date.now(),
} = {}) {
  if (!hasStripeSecretKey()) {
    const error = new Error("Stripe is not configured.");
    error.code = "stripe_not_configured";
    throw error;
  }

  const eligible = isEligibleFixter(fixter);
  const priceId = await ensureTipPriceId();
  const params = buildTipCheckoutParams({
    priceId,
    // Only a validated employee reaches the metadata. An unvalidated one is
    // dropped here rather than being written down and trusted later.
    fixter: eligible ? fixter : null,
    bookingId,
    userId,
    prefillEmail,
  });

  /*
   * The idempotency key is scoped to a booking, and is omitted when there is
   * no booking to scope it to.
   *
   * A shared key returns the FIRST session created under it. That is exactly
   * right for one customer refreshing their own tip link, and exactly wrong for
   * two strangers who both arrived without context: the second would be handed
   * the first one's session, which may already be paid, and their tip would be
   * lost. Letting Stripe generate a key there costs at most an abandoned
   * session, which costs nothing.
   */
  const scopedToBooking = idString(bookingId);

  /*
   * The options argument is omitted entirely rather than passed empty.
   * stripe-node rejects `create(params, {})` client side with "Unknown
   * arguments", so an empty object here would fail every unscoped tip before
   * it reached Stripe at all.
   */
  const session = scopedToBooking
    ? await stripe.checkout.sessions.create(params, {
        idempotencyKey: tipIdempotencyKey({
          fixterId: eligible ? idString(fixter?._id) : "",
          bookingId: scopedToBooking,
          now,
        }),
      })
    : await stripe.checkout.sessions.create(params);

  if (!session?.url) {
    const error = new Error("Stripe did not return a checkout page for this tip.");
    error.code = "checkout_url_missing";
    throw error;
  }

  return { url: session.url, sessionId: session.id, attributed: eligible };
}

/* ------------------------------------------------------------------ */
/* Recording the payment                                               */
/* ------------------------------------------------------------------ */

/**
 * The Tip record for a completed checkout.
 *
 * Pure, so the interesting decisions are visible in one place: which Fixter is
 * credited, whose name and email are kept, and what an unresolvable tip looks
 * like in the ledger.
 */
function tipRecordFromCheckoutSession(
  session,
  { fixter = null, booking = null, user = null, eventId = "", paidAt = null, recordedBy = "webhook", reviewReason = "" } = {}
) {
  const metadata = session?.metadata || {};
  const eligible = isEligibleFixter(fixter);
  const legacy = isLegacyTipPaymentLinkSession(session) && !isFixterTipCheckoutSession(session);
  /*
   * When the customer paid, not when we happened to write it down. The live
   * webhook passes the event time; reconcile and repair pass the charge time.
   * A tip recorded late must still land in the pay period it was paid in.
   */
  const when = paidAt instanceof Date && !Number.isNaN(paidAt.getTime()) ? paidAt : new Date();

  /*
   * ProFixter's own record of this customer outranks whatever was typed into
   * Stripe Checkout. The booking is what we actually know; the checkout form is
   * whatever the person at the keyboard entered, which may be a card holder who
   * is not the customer at all.
   */
  const tipperName =
    cleanText(booking?.name, 160) ||
    cleanText(user?.name, 160) ||
    cleanText(session?.customer_details?.name, 160);
  const tipperEmail =
    cleanEmail(booking?.email) ||
    cleanEmail(user?.email) ||
    cleanEmail(session?.customer_details?.email) ||
    cleanEmail(session?.customer_email);

  const paidStatus = String(session?.payment_status || "").toLowerCase();

  return {
    fixter: eligible ? fixter._id : null,
    fixterNameSnapshot: eligible ? cleanText(fixter.name, 160) : "",
    fixterPositionSnapshot: eligible ? String(fixter.employeePosition || "") : "",

    amountCents: Math.max(toCents(session?.amount_total), 0),
    currency: String(session?.currency || "usd").toLowerCase(),
    receivedAt: when,
    status: paidStatus === "paid" ? "succeeded" : "pending",

    stripePaymentIntentId: idString(session?.payment_intent),
    stripeCheckoutSessionId: idString(session?.id),
    stripeEventId: cleanText(eventId, 120),

    tipperName,
    tipperEmail,
    user: user?._id || null,
    /*
     * A booking or an account means ProFixter already knows this person. An
     * email Stripe collected and nothing else means a visitor. Nothing else is
     * inferred: an anonymous tip stays unknown rather than being filed as a
     * customer on a hunch.
     */
    tipperKind: user || booking ? "customer" : tipperEmail ? "visitor" : "unknown",

    booking: booking?._id || null,
    bookingNumberSnapshot: cleanText(booking?.bookingNumber, 60),

    refundedCents: 0,
    refundStatus: "",
    refundedAt: null,

    assignmentStatus: eligible ? "attributed" : "unassigned",
    attributionBasis: eligible ? (legacy ? "visit_history" : "checkout_token") : "",
    unassignedReason: eligible
      ? ""
      : legacy
        ? cleanText(reviewReason, 240) || "Paid through the old Stripe tip link, which carries no visit or Fixter. Assign by hand."
        : metadata.fixterId
          ? "The Fixter recorded on this tip is no longer a valid employee account."
          : "This tip arrived without Fixter context and must be assigned by hand.",
    needsReview: !eligible && legacy,
    reviewReason: !eligible && legacy ? cleanText(reviewReason, 240) || "No verifiable visit or Fixter for this old-link tip." : "",
    recordedBy: ["webhook", "reconcile", "repair"].includes(recordedBy) ? recordedBy : "webhook",

    source: legacy ? "legacy_payment_link" : metadata.source === "completion_email" ? "completion_email" : "direct",
  };
}

/**
 * Who an old-link tip is for, from the customer's own visit history.
 *
 * Pure. `visits` are the customer's bookings (any status); `fixtersById` maps
 * a Fixter id to its user record. The rule, strict on purpose:
 *   - only visits marked Completed, completed in the 30 days before the tip;
 *   - every one of them assigned to the same single, eligible Fixter;
 *   - the visit itself is linked only when exactly one was completed in the
 *     24 hours before the tip (otherwise the Fixter is still certain, the job
 *     is not, and the booking stays empty).
 * Any other shape returns no Fixter and a reason a person can act on.
 */
function attributionFromVisitHistory({ visits = [], fixtersById = new Map(), paidAt } = {}) {
  const paid = new Date(paidAt).getTime();
  if (!Number.isFinite(paid)) return { fixter: null, booking: null, reviewReason: "The tip has no payment time." };

  const completed = visits
    .filter((visit) => String(visit?.status || "").toLowerCase() === "completed" && visit.completedAt)
    .map((visit) => ({ visit, at: new Date(visit.completedAt).getTime() }))
    .filter(({ at }) => Number.isFinite(at) && at <= paid && at >= paid - VISIT_HISTORY_WINDOW_MS);

  if (!completed.length) {
    return { fixter: null, booking: null, reviewReason: "Old-link tip: the customer had no completed visit in the 30 days before it." };
  }

  const fixterIds = new Set(completed.map(({ visit }) => idString(visit.assignedFixterId)));
  if (fixterIds.has("")) {
    return { fixter: null, booking: null, reviewReason: "Old-link tip: a recent visit has no Fixter recorded, so who it is for is not certain." };
  }
  if (fixterIds.size !== 1) {
    return { fixter: null, booking: null, reviewReason: "Old-link tip: the customer's recent visits were done by more than one Fixter." };
  }

  const fixter = fixtersById.get([...fixterIds][0]) || null;
  if (!isEligibleFixter(fixter)) {
    return { fixter: null, booking: null, reviewReason: "Old-link tip: the Fixter on the customer's recent visits is not a Fixter account." };
  }

  const sameVisit = completed.filter(({ at }) => at >= paid - SAME_VISIT_WINDOW_MS);
  return { fixter, booking: sameVisit.length === 1 ? sameVisit[0].visit : null, reviewReason: "" };
}

/**
 * Reduce a tip by what was refunded.
 *
 * The record is never deleted: the tip happened, and a history that quietly
 * loses refunded entries cannot be reconciled against Stripe. `amount_refunded`
 * is cumulative in Stripe, so this is idempotent across repeated deliveries and
 * correct for a partial refund followed by another.
 */
function applyRefundToTip(tip, charge) {
  const collected = Math.max(toCents(tip?.amountCents), 0);
  const already = Math.max(toCents(tip?.refundedCents), 0);
  const refunded = Math.min(Math.max(toCents(charge?.amount_refunded), 0), collected);

  if (refunded <= already) {
    return { changed: false, refundedCents: already, retainedCents: collected - already };
  }

  const full = refunded >= collected && collected > 0;
  tip.refundedCents = refunded;
  tip.refundStatus = full ? "full" : "partial";
  tip.status = full ? "refunded" : "partially_refunded";
  tip.refundedAt = new Date();

  return { changed: true, refundedCents: refunded, retainedCents: collected - refunded };
}

/* ------------------------------------------------------------------ */
/* Totals                                                              */
/* ------------------------------------------------------------------ */

/** What was kept: the tip less anything given back. Never negative. */
function netCents(tip) {
  return Math.max(toCents(tip?.amountCents) - toCents(tip?.refundedCents), 0);
}

const WEEKDAY_INDEX = Object.freeze({
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
});

/** Friday. The pay period opens as Friday begins in New York. */
const PAY_PERIOD_START_WEEKDAY = WEEKDAY_INDEX.Fri;

/** The New York calendar day for an instant, as [year, month, day]. */
function nyCalendarDay(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .split("-")
    .map(Number);
}

function ymd(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

/**
 * The Friday that opens this tip's pay period, as YYYY-MM-DD in New York.
 *
 * WHY FRIDAY AND NOT MONDAY
 * Cheques are written on Friday morning. A Monday-to-Sunday week meant working
 * out by hand which tips belonged on the cheque in your hand, and the answer
 * straddled two of the columns on screen. The period now closes on Thursday
 * night, so what you see on Friday morning is exactly what you are paying.
 *
 * BOUNDARIES ARE NEW YORK BUSINESS DAYS, NOT UTC INSTANTS
 * The calendar day and the weekday are both read in America/New_York and the
 * arithmetic is done on those numbers. A tip at 11:59pm on Thursday in New York
 * is already Friday in UTC, and reading the day in UTC would push it into the
 * next period and short that cheque. Because only calendar numbers are
 * manipulated, daylight saving cannot move a tip either: an hour that repeats
 * or never happens does not change which day it falls on.
 */
function payPeriodStartNY(value) {
  // new Date(null) is the epoch, not an error, so an absent date would
  // otherwise resolve to a real period in 1970 rather than to nothing.
  if (value === null || value === undefined || value === "") return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const [year, month, day] = nyCalendarDay(date);
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    weekday: "short",
  }).format(date);

  const daysSinceFriday = (WEEKDAY_INDEX[weekday] - PAY_PERIOD_START_WEEKDAY + 7) % 7;
  return ymd(year, month - 1, day - daysSinceFriday);
}

/**
 * The whole period a start Friday describes.
 *
 * `end` is the Thursday it closes on and `payday` is the Friday morning the
 * cheque is written, which is the day after it closes. Tips received on that
 * Friday belong to the next cheque, not the one being written.
 */
function payPeriodFromStart(start) {
  if (!start) return null;
  const [year, month, day] = start.split("-").map(Number);
  return {
    start,
    end: ymd(year, month - 1, day + 6),
    payday: ymd(year, month - 1, day + 7),
  };
}

/** The period an instant falls in, as {start, end, payday}. */
function payPeriodForDate(value) {
  return payPeriodFromStart(payPeriodStartNY(value));
}

/** The last `count` pay periods, oldest first, ending with the current one. */
function recentPayPeriods({ now = new Date(), count = 8 } = {}) {
  const current = payPeriodStartNY(now);
  if (!current) return [];
  const [year, month, day] = current.split("-").map(Number);
  const periods = [];
  for (let index = count - 1; index >= 0; index -= 1) {
    periods.push(payPeriodFromStart(ymd(year, month - 1, day - index * 7)));
  }
  return periods;
}

/**
 * Every figure the admin and the Fixters see, summed from the records.
 *
 * There is no stored total to drift: pass the tips, get the numbers. Refunded
 * cents are subtracted rather than the record being skipped, so a partially
 * refunded tip reduces its period by exactly what went back.
 *
 * Admin and Fixter both come through here, which is what stops the two views
 * ever disagreeing about the same period.
 */
function summarizeTips(tips = [], { now = new Date(), periods = 8 } = {}) {
  const payPeriods = recentPayPeriods({ now, count: Math.max(periods, 2) });
  const periodStarts = payPeriods.map((period) => period.start);

  /*
   * TWO PERIODS MATTER, NOT ONE.
   *
   * `current` is the one accumulating right now. `closing` is the one before
   * it, and its payday is exactly the Friday that opens `current` - so on a
   * Friday morning, `closing` is the cheque being written and `current` is the
   * period that began hours ago and will be paid next week. Reporting only one
   * would either hide today's cheque or misfile a Friday tip, and the whole
   * point of this change is that neither needs working out by hand.
   */
  const currentPeriod = payPeriods[payPeriods.length - 1] || null;
  const closingPeriod = payPeriods[payPeriods.length - 2] || null;
  const currentStart = currentPeriod?.start || "";
  const closingStart = closingPeriod?.start || "";

  const byFixter = new Map();
  const blank = () => ({ allTimeCents: 0, currentPeriodCents: 0, closingPeriodCents: 0, count: 0 });
  const unassigned = blank();
  const totals = blank();

  for (const tip of tips) {
    const cents = netCents(tip);
    const start = payPeriodStartNY(tip?.receivedAt);
    const isCurrent = start === currentStart;
    const isClosing = start === closingStart;

    totals.allTimeCents += cents;
    totals.count += 1;
    if (isCurrent) totals.currentPeriodCents += cents;
    if (isClosing) totals.closingPeriodCents += cents;

    const fixterId = idString(tip?.fixter);
    if (!fixterId) {
      // Unassigned money is kept out of every Fixter total until an admin
      // places it, so a period never credits somebody who was not chosen.
      unassigned.allTimeCents += cents;
      unassigned.count += 1;
      if (isCurrent) unassigned.currentPeriodCents += cents;
      if (isClosing) unassigned.closingPeriodCents += cents;
      continue;
    }

    if (!byFixter.has(fixterId)) {
      byFixter.set(fixterId, {
        fixterId,
        name: cleanText(tip?.fixterNameSnapshot, 160),
        position: String(tip?.fixterPositionSnapshot || ""),
        ...blank(),
        byPeriod: Object.fromEntries(periodStarts.map((value) => [value, 0])),
      });
    }

    const row = byFixter.get(fixterId);
    row.allTimeCents += cents;
    row.count += 1;
    if (isCurrent) row.currentPeriodCents += cents;
    if (isClosing) row.closingPeriodCents += cents;
    if (start in row.byPeriod) row.byPeriod[start] += cents;
    if (!row.name) row.name = cleanText(tip?.fixterNameSnapshot, 160);
  }

  return {
    payPeriods,
    periodStarts,
    currentPeriod,
    closingPeriod,
    fixters: [...byFixter.values()].sort((left, right) => right.allTimeCents - left.allTimeCents),
    unassigned,
    totals,
  };
}

module.exports = {
  FIXTER_TIP_PRODUCT_KIND,
  TIPPABLE_POSITIONS,
  TIP_MIN_CENTS,
  TIP_MAX_CENTS,
  TIP_PRESET_CENTS,
  TIP_PRICE_LOOKUP_KEY,
  TIP_SESSION_WINDOW_MS,
  TIP_LEDGER_STARTED_AT,
  DEFAULT_LEGACY_TIP_PAYMENT_LINK_IDS,
  applyRefundToTip,
  attributionFromVisitHistory,
  isLegacyTipPaymentLinkSession,
  isTipCheckoutSession,
  legacyTipPaymentLinkIds,
  buildTipCheckoutParams,
  createTipCheckoutSession,
  ensureTipPriceId,
  isEligibleFixter,
  isFixterTipCheckoutSession,
  isSelectableFixter,
  netCents,
  payPeriodForDate,
  payPeriodFromStart,
  payPeriodStartNY,
  publicFixterDTO,
  publicFixterList,
  recentPayPeriods,
  summarizeTips,
  tipCheckoutMetadata,
  tipIdempotencyKey,
  tipPageUrl,
  tipRecordFromCheckoutSession,
  tipUrlForBooking,
};
