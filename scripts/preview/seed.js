/**
 * Deterministic, invented seed data for the local Admin preview.
 *
 * Everything here is made up: "Test Customer NN", (516) 555-01NN phones,
 * @example.test emails, "Oak Demo St"-style streets in Long Island towns. Ids
 * are fixed (see oid()), names, plans and amounts are fixed; only the dates
 * move, because they are placed relative to the day the seed runs (-14..+14
 * days in New York time) so Today / Needs action / Schedule always have work.
 *
 * Bookings in the future are created through the real reservation engine
 * (createBookingWithReservation / reserveGuestFreeVisit / createFullDayBooking)
 * so capacity, assignment and the schedule agree; past and "not closed" jobs
 * are inserted directly, as the engine refuses to reserve the past.
 *
 * NEVER point this at a real database: start.js only calls it against the
 * preview's own 127.0.0.1 replica set, and seedPreview() checks that again.
 */

const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const BACKEND = path.resolve(__dirname, "..", "..");
const req = (rel) => require(path.join(BACKEND, rel));

const mongoose = require(require.resolve("mongoose", { paths: [BACKEND] }));
const moment = require(require.resolve("moment-timezone", { paths: [BACKEND] }));
const bcrypt = require(require.resolve("bcryptjs", { paths: [BACKEND] }));

const TZ = "America/New_York";
const SEED_VERSION = 1;

const ACCOUNTS = Object.freeze({
  owner: { email: "owner@preview.test", password: "preview-owner-1", name: "Preview Owner" },
  general: { email: "general@preview.test", password: "preview-general-1", name: "Gabe General" },
  fixter1: { email: "fixter1@preview.test", password: "preview-fixter-1", name: "Fixter One" },
  fixter2: { email: "fixter2@preview.test", password: "preview-fixter-2", name: "Fixter Two" },
  customer: { email: "customer01@example.test", password: "preview-customer-1", name: "Test Customer 01" },
});

/** Fixed ObjectIds: kind prefix + counter, so URLs stay the same after every --reset. */
const PREFIX = { user: "a0", address: "a1", sub: "a2", booking: "b0", ent: "b1", request: "c0", estimate: "c1", project: "d0", contract: "d1", co: "d2", invoice: "d3", sig: "d4", misc: "e0" };
function oid(kind, n) {
  return new mongoose.Types.ObjectId(`${PREFIX[kind]}${String(n).padStart(22, "0")}`);
}

const STREETS = ["Oak Demo St", "Maple Demo Ave", "Birch Demo Ln", "Cedar Demo Ct", "Elm Demo Rd", "Willow Demo Dr", "Harbor Demo Blvd", "Dune Demo Way"];
const TOWNS = [
  { city: "Huntington", zip: "11743", county: "Suffolk" },
  { city: "Farmingdale", zip: "11735", county: "Nassau" },
  { city: "Babylon", zip: "11702", county: "Suffolk" },
  { city: "Massapequa", zip: "11758", county: "Nassau" },
  { city: "Smithtown", zip: "11787", county: "Suffolk" },
  { city: "Bay Shore", zip: "11706", county: "Suffolk" },
  { city: "Garden City", zip: "11530", county: "Nassau" },
  { city: "Patchogue", zip: "11772", county: "Suffolk" },
];
const SERVICES = ["Fix a sticking door", "Mount a TV", "Patch drywall", "Replace a light fixture", "Assemble furniture", "Re-caulk the bathtub", "Fix a leaky faucet", "Hang shelves", "Install smoke detectors", "Repair a fence gate"];
const PLAN_LABEL = { basic: "Basic", plus: "Plus", premium: "Premium", elite: "Elite" };

const pad2 = (n) => String(n).padStart(2, "0");

/* ------------------------------------------------------------------ */
/* Membership plan per customer number                                 */
/* ------------------------------------------------------------------ */

/*
 *  1-10 active   11-12 trialing   13-15 past_due   16-18 ending (cancel_at)
 *  19-21 ended   22 complimentary (owner grant, no Stripe)   23-40 none
 *  customer 3 also has an active plan on a second home.
 */
function membershipFor(n) {
  const plans = ["basic", "plus", "premium", "elite"];
  if (n <= 10) return { state: "active", plan: n === 5 ? "elite" : plans[n % 4], cycle: n === 8 || n === 9 ? "annual" : "monthly", months: 2 + (n % 7) };
  if (n <= 12) return { state: "trialing", plan: plans[n % 4], cycle: "monthly", months: 0 };
  if (n <= 15) return { state: "past_due", plan: plans[n % 4], cycle: "monthly", months: 3 + (n % 3) };
  if (n <= 18) return { state: "ending", plan: plans[n % 4], cycle: "monthly", months: 4 + (n % 4), mode: n === 16 ? "period_end" : "date" };
  if (n <= 21) return { state: "ended", plan: plans[n % 4], cycle: "monthly", months: 3 };
  if (n === 22) return { state: "complimentary", plan: "plus", cycle: "monthly", months: 1 };
  return null;
}

function addMonths(date, months) {
  const d = new Date(date);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}
function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * 86400000);
}

/* ------------------------------------------------------------------ */
/* Placeholder files (images, PDFs) in the local S3 store              */
/* ------------------------------------------------------------------ */

async function photoBuffer({ title, subtitle, hue = 210, width = 960, height = 720 }) {
  const sharp = require(require.resolve("sharp", { paths: [BACKEND] }));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},40%,38%)"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect x="${width * 0.08}" y="${height * 0.62}" width="${width * 0.84}" height="${height * 0.26}" rx="18" fill="rgba(0,0,0,0.35)"/>
    <text x="50%" y="${height * 0.74}" font-family="Arial, sans-serif" font-size="${Math.round(width / 22)}" fill="#fff" text-anchor="middle">${esc(title)}</text>
    <text x="50%" y="${height * 0.83}" font-family="Arial, sans-serif" font-size="${Math.round(width / 40)}" fill="#e5e7eb" text-anchor="middle">${esc(subtitle)}</text>
    <text x="${width - 16}" y="28" font-family="Arial, sans-serif" font-size="18" fill="rgba(255,255,255,0.8)" text-anchor="end">PREVIEW - invented data</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 78 }).toBuffer();
}

function pdfBuffer(title, lines = []) {
  const PDFDocument = require(require.resolve("pdfkit", { paths: [BACKEND] }));
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 64 });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(10).fillColor("#b91c1c").text("PREVIEW DOCUMENT - invented data, not a real agreement or invoice", { align: "center" });
    doc.moveDown(2).fillColor("#111827").fontSize(20).text(title);
    doc.moveDown().fontSize(11);
    for (const line of lines) doc.text(line).moveDown(0.4);
    doc.end();
  });
}

/* ------------------------------------------------------------------ */
/* Seed                                                                 */
/* ------------------------------------------------------------------ */

async function seedPreview({ s3, log = console.log, now = new Date() } = {}) {
  const host = String(mongoose.connection?.host || "");
  if (mongoose.connection.readyState !== 1 || !["127.0.0.1", "localhost"].includes(host)) {
    throw new Error("Refusing to seed: the preview seed only runs against the local preview database.");
  }

  const User = req("models/User");
  const Subscription = req("models/Subscription");
  const Booking = req("models/Booking");
  const VisitEntitlement = req("models/VisitEntitlement");
  const CompanyAvailabilityTemplate = req("models/CompanyAvailabilityTemplate");
  const CalendarConfig = req("models/CalendarConfig");
  const Request = req("models/Request");
  const EstimateLead = req("models/EstimateLead");
  const Project = req("models/Project");
  const Contract = req("models/Contract");
  const ChangeOrder = req("models/ChangeOrder");
  const Invoice = req("models/Invoice");
  const ESignature = req("models/ESignature");
  const Blacklist = req("models/Blacklist");
  const Tip = req("models/Tip");
  const ConsentEvent = req("models/ConsentEvent");
  const AdminActivityLog = req("models/AdminActivityLog");
  const PromotionPopup = req("models/PromotionPopup");
  const WorkPhoto = req("models/WorkPhoto");
  const EmailLog = req("models/EmailLog");
  const SmsMessage = req("models/SmsMessage");
  const LoyaltyCycle = req("models/LoyaltyCycle");
  const LoyaltyGrant = req("models/LoyaltyGrant");
  const sm = req("utils/subscriptionManagement");
  const { createBookingWithReservation } = req("utils/slotReservationService");
  const { reserveGuestFreeVisit } = req("utils/freeVisit/guestVisit");
  const { convertLeadToProject, resolveLeadSource } = req("utils/projects/leadConversion");
  const { hashToken } = req("utils/esign/nativeSigning");

  const counts = {};
  const bump = (key, by = 1) => (counts[key] = (counts[key] || 0) + by);
  const warnings = [];

  await Promise.all(
    [User, Booking, Subscription, Request, Project, Tip, SmsMessage, req("models/BookingSlotReservation"), req("models/ReservationTimeBucket"), req("models/ReservationCapacityBucket"), req("models/AdminIdempotencyRecord"), req("models/FreeVisitLock")].map((m) =>
      m.init().catch(() => {})
    )
  );
  await req("models/FreeVisitLock").createCollection().catch(() => {});

  const nyNow = moment.tz(now, TZ);
  const dayAt = (offset, time) => moment.tz(`${nyNow.clone().add(offset, "days").format("YYYY-MM-DD")} ${time}`, "YYYY-MM-DD HH:mm", TZ).toDate();
  const isSunday = (offset) => nyNow.clone().add(offset, "days").day() === 0;
  const ymd = (offset) => nyNow.clone().add(offset, "days").format("YYYY-MM-DD");

  /* ---------------- calendar ---------------- */
  await CalendarConfig.create({ timezone: TZ, slotMinutes: 60, minLeadDays: 0, closedWeekdays: [0], defaultHours: ["08:00", "10:00", "13:00", "15:00"], maxConcurrent: 3 });
  await CompanyAvailabilityTemplate.create({
    active: true,
    name: "Company Schedule (preview)",
    timezone: TZ,
    slotMinutes: 30,
    minLeadMinutes: 60,
    maxAdvanceDays: 120,
    defaultCapacity: 3,
    visitDurationMinutes: 90,
    weeklySchedule: Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      enabled: weekday !== 0,
      starts: ["08:00", "10:00", "13:00", "15:00"].map((time) => ({ time, capacity: null })),
      intervals: [{ startTime: "08:00", endTime: "17:00", capacity: null }],
    })),
  });

  /* ---------------- staff ---------------- */
  const hash = (p) => bcrypt.hash(p, 10);
  const owner = await User.create({
    _id: oid("user", 1),
    userId: "10000001",
    name: ACCOUNTS.owner.name,
    firstName: "Preview",
    lastName: "Owner",
    email: ACCOUNTS.owner.email,
    phone: "+16315550190",
    password: await hash(ACCOUNTS.owner.password),
    role: "admin",
    isActive: true,
    signupMethod: "password",
  });
  const staff = async (n, key, position, extra = {}) =>
    User.create({
      _id: oid("user", n),
      userId: String(10000000 + n),
      name: ACCOUNTS[key].name,
      firstName: ACCOUNTS[key].name.split(" ")[0],
      lastName: ACCOUNTS[key].name.split(" ").slice(1).join(" "),
      email: ACCOUNTS[key].email,
      phone: `+1631555019${n}`,
      password: await hash(ACCOUNTS[key].password),
      role: "employee",
      employeePosition: position,
      employeeTitle: position,
      isActive: true,
      adminSectionsVersion: 2,
      employeeAvailabilityStatus: "Available",
      signupMethod: "admin",
      ...extra,
    });
  const general = await staff(2, "general", "General Fixter");
  const fixter1 = await staff(3, "fixter1", "Fixter", { isDefaultFixter: true });
  const fixter2 = await staff(4, "fixter2", "Fixter");
  const fixters = [fixter1, fixter2, general];
  bump("staff", 4);

  /* ---------------- customers ---------------- */
  const customers = [];
  for (let n = 1; n <= 40; n++) {
    const town = TOWNS[n % TOWNS.length];
    const hasUnit = [4, 11, 20, 27, 35].includes(n);
    const unit = hasUnit ? (n % 2 ? "Apt 2B" : "Unit 3") : "";
    const street = `${10 + n * 7} ${STREETS[n % STREETS.length]}`;
    const addresses = [
      { _id: oid("address", n * 10 + 1), label: "Home", line1: unit ? `${street}, ${unit}` : street, unit, city: town.city, state: "NY", zip: town.zip, county: town.county },
    ];
    if ([3, 9, 14, 25, 31].includes(n)) {
      const t2 = TOWNS[(n + 3) % TOWNS.length];
      addresses.push({ _id: oid("address", n * 10 + 2), label: "Rental", line1: `${200 + n} ${STREETS[(n + 3) % STREETS.length]}`, unit: "", city: t2.city, state: "NY", zip: t2.zip, county: t2.county });
    }
    const createdAt = addDays(now, -(30 + n * 9));
    const consented = n <= 20 || n % 3 === 0;
    const user = await User.create({
      _id: oid("user", 100 + n),
      userId: String(30000000 + n),
      name: `Test Customer ${pad2(n)}`,
      firstName: "Test",
      lastName: `Customer ${pad2(n)}`,
      email: `customer${pad2(n)}@example.test`,
      phone: `+1516555${String(100 + n).padStart(4, "0")}`,
      ...(n === 1 ? { password: await hash(ACCOUNTS.customer.password), signupMethod: "password" } : { signupMethod: n % 2 ? "phone" : "email_code" }),
      role: "customer",
      isActive: true,
      addresses,
      defaultAddressId: addresses[0]._id,
      address: addresses[0].line1,
      city: addresses[0].city,
      state: "NY",
      zip: addresses[0].zip,
      county: addresses[0].county,
      phoneVerifiedAt: n % 4 !== 0 ? createdAt : null,
      emailVerifiedAt: n % 3 !== 0 ? createdAt : null,
      termsAcceptedAt: createdAt,
      termsVersion: "2026-10",
      smsPreferences: consented
        ? { transactionalEnabled: n !== 7, transactionalConsentAt: createdAt, transactionalConsentSource: "signup", marketingEnabled: n % 5 === 0, marketingConsentAt: n % 5 === 0 ? createdAt : null, marketingConsentSource: n % 5 === 0 ? "signup_checkbox" : "", optedOutAt: n === 7 ? addDays(now, -6) : null, optOutSource: n === 7 ? "sms_stop" : "" }
        : {},
      emailPreferences: n % 4 === 0 ? { marketingConsentAt: createdAt, marketingConsentSource: "signup", marketingConsentVersion: "2026-10" } : {},
      ...(n <= 22 ? { stripeCustomerId: `cus_preview_${pad2(n)}` } : {}),
      ...([2, 13, 30].includes(n)
        ? { adminNotes: [{ text: n === 13 ? "Card keeps failing; asked them to update it in the portal. (preview)" : n === 30 ? "Prefers texts after 5pm. Has a dog. (preview)" : "Gate code 4412. Park on the street. (preview)", authorId: owner._id, authorName: owner.name, at: addDays(now, -n % 9) }] }
        : {}),
      createdAt,
    });
    customers.push(user);
  }
  bump("customers", customers.length);
  const C = (n) => customers[n - 1];

  /* ---------------- memberships ---------------- */
  const subsByCustomer = new Map();
  let subSeq = 0;
  async function createSubscription(customer, address, def) {
    subSeq += 1;
    const n = Number(customer.userId) - 30000000;
    const catalog = sm.PLAN_CATALOG[def.plan][def.cycle];
    const months = def.cycle === "annual" ? 12 : 1;
    let startDate;
    let currentPeriodStart;
    if (def.state === "trialing") {
      startDate = addDays(now, -5);
      currentPeriodStart = startDate;
    } else if (def.cycle === "annual") {
      startDate = addDays(now, -(40 + n * 3));
      currentPeriodStart = startDate;
    } else {
      startDate = addDays(addMonths(now, -def.months), -(n % 20));
      currentPeriodStart = addMonths(startDate, def.months);
      if (currentPeriodStart > now) currentPeriodStart = addMonths(currentPeriodStart, -1);
    }
    let currentPeriodEnd = def.state === "trialing" ? addDays(now, 25) : addMonths(currentPeriodStart, months);
    let status = def.state === "ending" ? "active" : def.state === "complimentary" ? "active" : def.state === "ended" ? "canceled" : def.state;
    let cancelAtPeriodEnd = false;
    let cancellationDate = null;
    let cancellationReason = null;
    if (def.state === "ended") {
      currentPeriodEnd = addDays(now, -(10 + n * 4));
      currentPeriodStart = addMonths(currentPeriodEnd, -1);
      startDate = addMonths(currentPeriodStart, -def.months);
      cancellationDate = currentPeriodEnd;
      cancellationReason = n === 19 ? "customer_request" : n === 20 ? "payment_failed" : "moving";
    }
    if (def.state === "ending") {
      if (def.mode === "period_end") cancelAtPeriodEnd = true;
      else cancellationDate = addDays(now, n === 17 ? 9 : 19);
      cancellationReason = "customer_request";
    }
    const stripeManaged = def.state !== "complimentary";
    const subId = stripeManaged ? `sub_preview_${pad2(subSeq)}` : null;
    const doc = await Subscription.create({
      _id: oid("sub", subSeq),
      user: customer._id,
      userId: customer.userId,
      subscriptionType: def.plan,
      addressId: address._id,
      addressSnapshot: { line1: address.line1, city: address.city, state: address.state, zip: address.zip, county: address.county },
      stripeCustomerId: stripeManaged ? customer.stripeCustomerId : null,
      stripeSubscriptionId: subId,
      stripeSubscriptionItemId: stripeManaged ? `si_preview_${pad2(subSeq)}` : null,
      stripePriceId: stripeManaged ? catalog.stripePriceId : null,
      billingCycle: def.cycle,
      startDate,
      latestPaymentDate: def.state === "past_due" ? addMonths(currentPeriodStart, -months) : currentPeriodStart,
      nextPaymentDate: currentPeriodEnd,
      currentPeriodStart,
      currentPeriodEnd: def.state === "complimentary" ? null : currentPeriodEnd,
      trialStart: def.state === "trialing" ? startDate : null,
      trialEnd: def.state === "trialing" ? currentPeriodEnd : null,
      latestInvoiceStatus: def.state === "past_due" ? "open" : "paid",
      latestPaymentIntentStatus: def.state === "past_due" ? "requires_payment_method" : "succeeded",
      accessStatus: ["active", "trialing", "ending", "complimentary"].includes(def.state) ? "active" : "inactive",
      status,
      cancelAtPeriodEnd,
      cancellationDate,
      cancellationReason,
      planPrice: def.state === "complimentary" ? 0 : catalog.price,
      paymentMethod: def.state === "complimentary" ? "complimentary" : "card",
      ...(def.state === "complimentary"
        ? { complimentary: { reason: "Thank-you for referring three neighbours (preview)", grantedBy: owner._id, grantedByName: owner.name, grantedAt: startDate } }
        : {}),
    });
    if (!subsByCustomer.has(n)) subsByCustomer.set(n, []);
    subsByCustomer.get(n).push(doc);
    bump(`membership_${def.state}`);
    return doc;
  }
  for (let n = 1; n <= 22; n++) {
    const def = membershipFor(n);
    if (!def) continue;
    await createSubscription(C(n), C(n).addresses[0], def);
    if (["active", "trialing", "ending", "complimentary"].includes(def.state)) {
      await User.updateOne({ _id: C(n)._id }, { $set: { subscription: PLAN_LABEL[def.plan] } });
    }
  }
  await createSubscription(C(3), C(3).addresses[1], { state: "active", plan: "basic", cycle: "monthly", months: 2 });

  /* ---------------- loyalty (counted paid months for active members) ---------------- */
  for (const [n, subs] of subsByCustomer) {
    for (const sub of subs) {
      if (!["active", "past_due"].includes(sub.status) || sub.billingCycle !== "monthly" || !sub.stripeSubscriptionId) continue;
      const paidPeriods = [];
      let cursor = new Date(sub.startDate);
      while (cursor <= (sub.status === "past_due" ? addMonths(sub.currentPeriodStart, -1) : sub.currentPeriodStart)) {
        paidPeriods.push(new Date(cursor));
        cursor = addMonths(cursor, 1);
      }
      for (let i = 0; i < paidPeriods.length; i++) {
        await LoyaltyCycle.create({
          user: sub.user,
          userId: sub.userId,
          addressId: sub.addressId,
          plan: sub.subscriptionType,
          generation: 1,
          sequence: i + 1,
          periodStart: paidPeriods[i],
          periodEnd: addMonths(paidPeriods[i], 1),
          source: "subscription_cycle",
          stripeInvoiceId: `in_${sub.stripeSubscriptionId.slice(4)}_${String(i + 1).padStart(2, "0")}`,
          stripeSubscriptionId: sub.stripeSubscriptionId,
          amountPaidCents: Math.round(sm.PLAN_CATALOG[sub.subscriptionType].monthly.price * 100),
          countedAt: paidPeriods[i],
        });
        bump("loyalty_cycles");
      }
      if (paidPeriods.length >= 3 && n === 6) {
        await LoyaltyGrant.create({
          user: sub.user,
          userId: sub.userId,
          addressId: sub.addressId,
          generation: 1,
          milestone: 3,
          rewardKind: "tier_upgrade",
          windowMinimumPlan: sub.subscriptionType,
          windowPlans: [sub.subscriptionType],
          windowStartSequence: 1,
          windowEndSequence: 3,
          triggeringInvoiceId: `in_${sub.stripeSubscriptionId.slice(4)}_03`,
          rewardPlan: sub.subscriptionType === "elite" ? "elite" : ["basic", "plus", "premium", "elite"][["basic", "plus", "premium", "elite"].indexOf(sub.subscriptionType) + 1],
          cycles: 1,
          effectiveFrom: addMonths(paidPeriods[2], 1),
          effectiveUntil: addMonths(paidPeriods[2], 2),
          status: addMonths(paidPeriods[2], 2) < now ? "expired" : "granted",
          grantedAt: addMonths(paidPeriods[2], 1),
        });
        bump("loyalty_grants");
      }
    }
  }

  /* ---------------- photos ---------------- */
  async function bookingPhoto(bookingNumber, index, label) {
    const key = `uploads/bookings/${bookingNumber}/${1762000000000 + index}-customer-photo-${index}.jpg`;
    const body = await photoBuffer({ title: label, subtitle: `Booking ${bookingNumber} - photo ${index}`, hue: (Number(bookingNumber) * 37 + index * 50) % 360 });
    bump("photos");
    return s3.putPublicObject({ Key: key, Body: body, ContentType: "image/jpeg" });
  }

  /* ---------------- bookings ---------------- */
  let bookingSeq = 0;
  const created = [];
  const engineFallbacks = [];
  function baseBooking(customer, address, { service, status = "Pending", plan = null, extra = {} } = {}) {
    bookingSeq += 1;
    return {
      _id: oid("booking", bookingSeq),
      bookingNumber: String(50000000 + bookingSeq),
      service: service || SERVICES[bookingSeq % SERVICES.length],
      selectedTask: service || SERVICES[bookingSeq % SERVICES.length],
      user: customer._id,
      userId: customer.userId,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      addressId: address._id,
      address: address.line1,
      unit: address.unit || "",
      city: address.city,
      state: "NY",
      zip: address.zip,
      county: address.county,
      subscription: plan ? PLAN_LABEL[plan] : "None",
      accessType: "membership",
      bookingType: "membership_visit",
      paymentState: "not_required",
      status,
      note: bookingSeq % 4 === 0 ? "Please call when you are 10 minutes away. The side door sticks. (preview)" : "",
      ...extra,
    };
  }
  const fixterFields = (f) => (f ? { assignedFixterId: f._id, assignedFixterName: f.name, assignedFixterEmail: f.email, assignedFixterPosition: f.employeePosition, assignedHandyman: f.name } : {});

  async function direct(data, date, { fixter = null, completed = false, canceled = false } = {}) {
    const doc = {
      ...data,
      date,
      scheduledStart: date,
      scheduledEnd: new Date(date.getTime() + 90 * 60000),
      ...fixterFields(fixter),
      assignmentSource: fixter ? "admin" : "",
      statusHistory: [{ status: "Pending", date: addDays(date, -3) }, ...(data.status !== "Pending" ? [{ status: data.status, date: completed ? new Date(date.getTime() + 2 * 3600000) : addDays(date, -1) }] : [])],
      ...(completed ? { completedAt: new Date(date.getTime() + 2 * 3600000) } : {}),
      ...(canceled ? { cancellationReason: data.cancellationReason || "Customer canceled (preview)" } : {}),
      createdAt: addDays(date, -4),
    };
    const booking = await Booking.create(doc);
    created.push(booking);
    bump(`booking_${data.status}`);
    return booking;
  }

  async function engine(data, slotStart, { fixter = null, reservationStatus } = {}) {
    try {
      const { booking } = await createBookingWithReservation({
        bookingData: data,
        slotStart,
        technicianId: fixter ? fixter._id : null,
        createdByType: "admin",
        actorUser: owner,
        assignmentSource: fixter ? "admin" : "automatic",
        ...(reservationStatus ? { reservationStatus } : {}),
      });
      created.push(booking);
      bump(`booking_${data.status}`);
      return booking;
    } catch (error) {
      engineFallbacks.push(`${data.bookingNumber}: ${error.code || error.message}`);
      return direct(data, slotStart, { fixter });
    }
  }

  // Past two weeks: completed work, a few cancellations, tips later.
  const memberNumbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 16, 17, 19];
  let pastIndex = 0;
  for (let d = -14; d <= -1; d++) {
    if (isSunday(d)) continue;
    for (const time of ["08:00", "13:00"]) {
      pastIndex += 1;
      const cn = memberNumbers[pastIndex % memberNumbers.length];
      const customer = C(cn);
      const plan = (subsByCustomer.get(cn) || [])[0]?.subscriptionType || null;
      const canceled = pastIndex % 6 === 0;
      const fixter = fixters[pastIndex % fixters.length];
      if (pastIndex === 5) {
        // A one-time paid visit, completed.
        const ent = await VisitEntitlement.create({ _id: oid("ent", 1), user: C(28)._id, userId: C(28).userId, addressId: C(28).addresses[0]._id, addressSnapshot: C(28).addresses[0], kind: "one_time_handyman_visit", status: "consumed", priceCents: 9900, stripeCustomerId: null, stripeCheckoutSessionId: "cs_test_preview_onetime_01", stripePaymentIntentId: "pi_preview_onetime_01", purchasedAt: addDays(dayAt(d, time), -2), consumedAt: dayAt(d, time), source: "purchase" });
        const b = await direct(baseBooking(C(28), C(28).addresses[0], { status: "Completed", service: "Replace a light fixture", extra: { accessType: "one_time", bookingType: "one_time_handyman_visit", subscription: "One-Time Visit", paymentState: "paid", entitlementId: ent._id } }), dayAt(d, time), { fixter, completed: true });
        await VisitEntitlement.updateOne({ _id: ent._id }, { $set: { bookingId: b._id } });
        continue;
      }
      if (pastIndex === 9) {
        await direct(baseBooking(C(34), C(34).addresses[0], { status: "Completed", service: "Admin free visit: gutter check", extra: { accessType: "admin", subscription: "Admin free visit", createdByAdmin: { by: owner._id, byName: owner.name, at: addDays(dayAt(d, time), -3) } } }), dayAt(d, time), { fixter, completed: true });
        continue;
      }
      if (pastIndex === 3) {
        await direct(baseBooking(C(36), C(36).addresses[0], { status: "Completed", service: "Free Visit - to-do review", extra: { accessType: "free_first_visit", subscription: "Free visit", isFreeFirstVisit: true, freeFirstVisitClaimedAt: addDays(dayAt(d, time), -5), freeVisitChannel: "online", freeVisitPurpose: "consultation" } }), dayAt(d, time), { fixter, completed: true });
        continue;
      }
      const data = baseBooking(customer, customer.addresses[0], { status: canceled ? "Canceled" : "Completed", plan, extra: canceled ? { cancellationReason: pastIndex % 12 === 0 ? "Customer rescheduled by phone (preview)" : "Customer canceled (preview)" } : {} });
      if (pastIndex % 7 === 0) data.adminNote = "Customer asked for the same Fixter next time. (preview)";
      if (pastIndex === 8 && !canceled) data.images = [await bookingPhoto(data.bookingNumber, 1, "Before: loose railing"), await bookingPhoto(data.bookingNumber, 2, "After: railing secured")];
      await direct(data, dayAt(d, time), { fixter, completed: !canceled, canceled });
    }
  }

  // Today.
  const nowMs = now.getTime();
  // Confirmed, more than 2h past its start and not closed: the latest working-hours start that is 3h+ ago.
  let notClosedStart = new Date(Math.floor((nowMs - 3 * 3600000) / 1800000) * 1800000);
  const ncHour = moment.tz(notClosedStart, TZ).hour();
  if (ncHour < 8 || ncHour > 15 || moment.tz(notClosedStart, TZ).day() === 0) {
    let back = moment.tz(notClosedStart, TZ).hour() < 8 ? -1 : 0;
    while (isSunday(back)) back -= 1;
    notClosedStart = dayAt(back, "15:00");
    if (notClosedStart.getTime() > nowMs - 3 * 3600000) {
      back -= 1;
      while (isSunday(back)) back -= 1;
      notClosedStart = dayAt(back, "15:00");
    }
  }
  const notClosed = await direct(baseBooking(C(2), C(2).addresses[0], { status: "Confirmed", plan: subsByCustomer.get(2)[0].subscriptionType, service: "Mount a TV" }), notClosedStart, { fixter: fixter1 });
  const todayCompletedAt = dayAt(0, "08:00");
  if (todayCompletedAt.getTime() < nowMs - 2.5 * 3600000 && todayCompletedAt.getTime() !== notClosedStart.getTime()) {
    await direct(baseBooking(C(4), C(4).addresses[0], { status: "Completed", plan: subsByCustomer.get(4)[0].subscriptionType }), todayCompletedAt, { fixter: fixter2, completed: true });
  }
  if (!isSunday(0)) {
    for (const time of ["10:00", "13:00", "15:00"]) {
      const at = dayAt(0, time);
      if (at.getTime() > nowMs + 90 * 60000) {
        await engine(baseBooking(C(6), C(6).addresses[0], { status: "Confirmed", plan: subsByCustomer.get(6)[0].subscriptionType, service: "Hang shelves" }), at, { fixter: fixter2 });
        break;
      }
    }
  }

  // The next two weeks.
  const futureDays = [];
  for (let d = 1; futureDays.length < 12 && d <= 16; d++) if (!isSunday(d)) futureDays.push(d);
  const [f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12] = futureDays;
  const planOf = (n) => (subsByCustomer.get(n) || [])[0]?.subscriptionType || null;

  // f1: confirmed with staff notes and photos; a member request; a callback free visit.
  const withPhotos = baseBooking(C(1), C(1).addresses[0], { status: "Confirmed", plan: planOf(1), service: "Patch drywall", extra: { note: "Two holes in the hallway from an old shelf, and a crack above the bedroom door. Photos attached. (preview)" } });
  withPhotos.images = [await bookingPhoto(withPhotos.bookingNumber, 1, "Hallway drywall"), await bookingPhoto(withPhotos.bookingNumber, 2, "Crack above door")];
  withPhotos.staffNotes = [
    { text: "Bring the 5-gallon mud bucket; the second hole is bigger than it looks. (preview)", authorId: general._id, authorName: general.name, authorRole: "General Fixter", at: addDays(now, -1) },
    { text: "Customer confirmed by phone. Parking in the driveway is fine. (preview)", authorId: owner._id, authorName: owner.name, authorRole: "admin", at: addDays(now, -0.5) },
  ];
  await engine(withPhotos, dayAt(f1, "08:00"), { fixter: fixter1 });
  await engine(baseBooking(C(3), C(3).addresses[1], { status: "Pending", plan: "basic", service: "Fix a leaky faucet" }), dayAt(f1, "10:00"));

  const callbackRequest = new Request({
    _id: oid("request", 1),
    name: "Test Customer 41",
    email: "customer41@example.test",
    phone: "+15165550141",
    address: "88 Harbor Demo Blvd",
    city: "Bay Shore",
    state: "NY",
    zip: "11706",
    serviceType: "free_visit_request",
    status: "pending_confirmation",
    message: "Kitchen cabinet doors hang crooked and a closet door will not latch. Can someone take a look? (preview)",
    sourcePage: "/book/free",
    requestedDate: ymd(f1),
    requestedTime: "13:00",
    requestedAt: dayAt(f1, "13:00"),
    contactConsent: { text: "You can call or text me about this request.", at: addDays(now, -1), ip: "127.0.0.1", userAgent: "preview-seed", pageUrl: "http://localhost:3105/book/free" },
    createdAt: addDays(now, -1),
  });
  try {
    bookingSeq += 1;
    const { booking } = await reserveGuestFreeVisit({
      request: callbackRequest,
      slotStart: dayAt(f1, "13:00"),
      bookingData: { _id: oid("booking", bookingSeq), bookingNumber: String(50000000 + bookingSeq), name: callbackRequest.name, phone: callbackRequest.phone, email: callbackRequest.email, note: callbackRequest.message, address: callbackRequest.address, city: callbackRequest.city, state: "NY", zip: callbackRequest.zip, freeVisitPurpose: "consultation", guestContactConsent: { text: callbackRequest.contactConsent.text, at: callbackRequest.contactConsent.at, ip: "127.0.0.1" } },
    });
    created.push(booking);
    bump("booking_Pending Confirmation");
  } catch (error) {
    warnings.push(`callback free visit not reserved: ${error.code || error.message}`);
    await callbackRequest.save();
  }

  // f2: online free visit (account holder), one-time paid, one-time awaiting payment.
  {
    const c = C(30);
    const data = baseBooking(c, c.addresses[0], { status: "Pending Confirmation", service: "Free Visit - to-do review", extra: { accessType: "free_first_visit", subscription: "Free visit", freeVisitChannel: "online", freeVisitPurpose: "consultation", note: "Want a list of small fixes priced out before the holidays. (preview)", freeVisitReview: { required: true, reasons: ["phone_matches_previous_free_visit"], matches: [{ kind: "phone", bookingNumber: "50000003" }], checkedAt: now } } });
    const b = await engine(data, dayAt(f2, "08:00"));
    await User.updateOne({ _id: c._id, "addresses._id": c.addresses[0]._id }, { $set: { "addresses.$.introVisit": { status: "claimed", bookingId: b._id, claimedAt: now } } });
  }
  {
    const c = C(26);
    const ent = await VisitEntitlement.create({ _id: oid("ent", 2), user: c._id, userId: c.userId, addressId: c.addresses[0]._id, addressSnapshot: c.addresses[0], kind: "one_time_handyman_visit", status: "paid", priceCents: 9900, stripeCheckoutSessionId: "cs_test_preview_onetime_02", stripePaymentIntentId: "pi_preview_onetime_02", purchasedAt: addDays(now, -2), source: "purchase" });
    const b = await engine(baseBooking(c, c.addresses[0], { status: "Confirmed", service: "Assemble furniture", extra: { accessType: "one_time", bookingType: "one_time_handyman_visit", subscription: "One-Time Visit", paymentState: "paid", entitlementId: ent._id } }), dayAt(f2, "10:00"), { fixter: fixter2 });
    await VisitEntitlement.updateOne({ _id: ent._id }, { $set: { bookingId: b._id } });
  }
  {
    const c = C(27);
    const ent = await VisitEntitlement.create({ _id: oid("ent", 3), user: c._id, userId: c.userId, addressId: c.addresses[0]._id, addressSnapshot: c.addresses[0], kind: "one_time_handyman_visit", status: "pending_payment", priceCents: 9900, holdExpiresAt: addDays(now, 0.02), stripeCheckoutSessionId: "cs_test_preview_onetime_03", source: "purchase" });
    const b = await direct(baseBooking(c, c.addresses[0], { status: "Pending", service: "Install smoke detectors", extra: { accessType: "one_time", bookingType: "one_time_handyman_visit", subscription: "One-Time Visit", paymentState: "pending", entitlementId: ent._id, paymentHoldExpiresAt: addDays(now, 0.02) } }), dayAt(f2, "13:00"));
    await VisitEntitlement.updateOne({ _id: ent._id }, { $set: { bookingId: b._id } });
  }

  // f3: Elite Full Day (included benefit).
  {
    const c = C(5);
    const ent = await VisitEntitlement.create({ _id: oid("ent", 4), user: c._id, userId: c.userId, addressId: c.addresses[0]._id, addressSnapshot: c.addresses[0], kind: "full_day_visit", status: "consumed", priceCents: 0, durationMinutes: 480, source: "membership_benefit", consumedAt: now, periodStart: subsByCustomer.get(5)[0].currentPeriodStart, periodEnd: subsByCustomer.get(5)[0].currentPeriodEnd });
    const data = baseBooking(c, c.addresses[0], { status: "Confirmed", plan: "elite", service: "Full Day: punch list around the house", extra: { bookingType: "full_day_visit", entitlementId: ent._id, note: "Full day: hang four pictures, fix two doors, caulk both bathrooms, replace the garage light. (preview)" } });
    let booking = null;
    try {
      const { createFullDayBooking } = req("utils/fullDayVisitService");
      ({ booking } = await createFullDayBooking({ bookingData: data, date: ymd(f3), actorUser: owner, createdByType: "admin", now }));
      created.push(booking);
      bump("booking_Confirmed");
    } catch (error) {
      engineFallbacks.push(`${data.bookingNumber} (full day): ${error.code || error.message}`);
      booking = await direct(data, dayAt(f3, "08:00"), { fixter: general });
      await Booking.updateOne({ _id: booking._id }, { $set: { scheduledEnd: dayAt(f3, "16:00") } });
    }
    await VisitEntitlement.updateOne({ _id: ent._id }, { $set: { bookingId: booking._id } });
  }

  // f4: admin free visit (Confirmed), confirmed but unassigned, member pending.
  await engine(baseBooking(C(33), C(33).addresses[0], { status: "Confirmed", service: "Admin free visit: check the attic fan", extra: { accessType: "admin", subscription: "Admin free visit", createdByAdmin: { by: owner._id, byName: owner.name, at: addDays(now, -1) } } }), dayAt(f4, "08:00"), { fixter: general });
  await direct(baseBooking(C(8), C(8).addresses[0], { status: "Confirmed", plan: planOf(8), service: "Repair a fence gate" }), dayAt(f4, "10:00"));
  await engine(baseBooking(C(9), C(9).addresses[1], { status: "Pending", plan: planOf(9), service: "Re-caulk the bathtub" }), dayAt(f4, "13:00"));

  // f5: reservation issue; failed payment.
  await direct(
    baseBooking(C(10), C(10).addresses[0], {
      status: "Pending",
      plan: planOf(10),
      service: "Fix a sticking door",
      extra: { reservationIssue: { status: "needs_review", code: "SLOT_TAKEN", message: "The time was taken by another booking while this one was being saved. Call the customer to pick another time. (preview)", occurredAt: addDays(now, -0.3) } },
    }),
    dayAt(f5, "10:00")
  );
  {
    const c = C(29);
    const ent = await VisitEntitlement.create({ _id: oid("ent", 5), user: c._id, userId: c.userId, addressId: c.addresses[0]._id, addressSnapshot: c.addresses[0], kind: "one_time_handyman_visit", status: "payment_failed", priceCents: 9900, stripeCheckoutSessionId: "cs_test_preview_onetime_05", source: "purchase" });
    const b = await direct(baseBooking(c, c.addresses[0], { status: "Pending", service: "Hang shelves", extra: { accessType: "one_time", bookingType: "one_time_handyman_visit", subscription: "One-Time Visit", paymentState: "failed", entitlementId: ent._id } }), dayAt(f5, "13:00"));
    await VisitEntitlement.updateOne({ _id: ent._id }, { $set: { bookingId: b._id } });
  }

  // The rest: ordinary member work, confirmed and pending, spread over the two weeks.
  const fill = [
    [f5, "08:00", 11, "Confirmed", fixter1],
    [f6, "08:00", 12, "Confirmed", fixter2],
    [f6, "10:00", 14, "Pending", null],
    [f6, "13:00", 16, "Confirmed", general],
    [f7, "08:00", 17, "Confirmed", fixter1],
    [f7, "10:00", 18, "Pending", null],
    [f7, "15:00", 1, "Confirmed", fixter2],
    [f8, "08:00", 2, "Confirmed", fixter1],
    [f8, "13:00", 3, "Confirmed", fixter2],
    [f9, "10:00", 4, "Pending", null],
    [f9, "13:00", 6, "Confirmed", general],
    [f10, "08:00", 7, "Confirmed", fixter1],
    [f10, "15:00", 22, "Pending", null],
    [f11, "10:00", 13, "Confirmed", fixter2],
    [f12, "08:00", 15, "Pending", null],
    [f8, "10:00", 5, "Confirmed", general],
    [f9, "08:00", 9, "Confirmed", fixter1],
    [f10, "10:00", 10, "Pending", null],
    [f11, "08:00", 11, "Confirmed", general],
    [f11, "13:00", 12, "Pending", null],
    [f12, "10:00", 14, "Confirmed", fixter2],
    [f12, "13:00", 16, "Confirmed", fixter1],
  ];
  for (const [d, time, cn, status, fixter] of fill) {
    if (d == null) continue;
    const c = C(cn);
    await engine(baseBooking(c, c.addresses[0], { status, plan: planOf(cn) }), dayAt(d, time), { fixter });
  }

  /* ---------------- tips ---------------- */
  const completedRows = created.filter((b) => b.status === "Completed" && b.assignedFixterId);
  let tipSeq = 0;
  for (const b of completedRows.filter((_, i) => i % 3 === 0).slice(0, 6)) {
    tipSeq += 1;
    await Tip.create({
      fixter: b.assignedFixterId,
      fixterNameSnapshot: b.assignedFixterName,
      fixterPositionSnapshot: b.assignedFixterPosition || "Fixter",
      amountCents: [1000, 2000, 1500, 2500, 500, 3000][tipSeq % 6],
      receivedAt: new Date(new Date(b.completedAt || b.date).getTime() + 5 * 3600000),
      status: "succeeded",
      stripePaymentIntentId: `pi_preview_tip_${pad2(tipSeq)}`,
      stripeCheckoutSessionId: `cs_test_preview_tip_${pad2(tipSeq)}`,
      tipperName: b.name,
      tipperEmail: b.email,
      user: b.user,
      tipperKind: "customer",
      booking: b._id,
      bookingNumberSnapshot: b.bookingNumber,
      assignmentStatus: "attributed",
      assignedAt: new Date(new Date(b.completedAt || b.date).getTime() + 5 * 3600000),
      source: "completion_email",
      notificationSentAt: new Date(new Date(b.completedAt || b.date).getTime() + 5 * 3600000),
    });
    bump("tips");
  }
  await Tip.create({ amountCents: 2000, receivedAt: addDays(now, -2), status: "succeeded", stripePaymentIntentId: "pi_preview_tip_unassigned", tipperName: "A grateful neighbour", tipperKind: "visitor", assignmentStatus: "unassigned", unassignedReason: "No booking context in the link (preview)", source: "direct" });
  bump("tips");

  /* ---------------- leads ---------------- */
  await Request.create([
    { _id: oid("request", 2), name: "Test Customer 42", email: "customer42@example.test", phone: "+15165550142", address: "17 Dune Demo Way", city: "Patchogue", state: "NY", zip: "11772", serviceType: "callback_request", status: "new", message: "Please call me about a free visit. Best after 4pm. (preview)", sourcePage: "/", contactConsent: { text: "You can call or text me about this request.", at: addDays(now, -0.2), ip: "127.0.0.1" }, createdAt: addDays(now, -0.2) },
    { _id: oid("request", 3), name: "Test Customer 43", email: "customer43@example.test", phone: "+15165550143", address: "5 Elm Demo Rd", city: "Smithtown", state: "NY", zip: "11787", serviceType: "general_contractor", status: "new", message: "Looking to finish the basement: framing, drywall, two egress windows. (preview)", sourcePage: "/projects", createdAt: addDays(now, -2) },
    { _id: oid("request", 4), name: "Test Customer 44", email: "customer44@example.test", phone: "+15165550144", address: "61 Cedar Demo Ct", city: "Massapequa", state: "NY", zip: "11758", serviceType: "home_improvement", status: "contacted", message: "New deck stairs and railing. (preview)", sourcePage: "/projects", createdAt: addDays(now, -6) },
    { _id: oid("request", 5), name: "Test Customer 45", email: "customer45@example.test", phone: "+15165550145", serviceType: "membership_interest", status: "new", message: "Does the Plus plan cover gutter cleaning? (preview)", sourcePage: "/membership/plans", createdAt: addDays(now, -1) },
  ]);
  bump("requests", 5);
  const estimateLeads = await EstimateLead.create([
    { _id: oid("estimate", 1), service: "bathroom", name: "Test Customer 46", phone: "(516) 555-0146", email: "customer46@example.test", address: "33 Willow Demo Dr, Huntington NY 11743", contactPref: "text", bestTime: "evenings", notes: "Two kids; we would like it done before summer. (preview)", estimateLow: 18000, estimateHigh: 26000, bathroomScope: "full", bathroomSize: "medium", bathroomItems: ["shower", "vanity", "tile", "lighting"], bathroomFinish: "premium", bathroomPlumbing: "maybe", timeline: "1-3months", budgetRange: "$20k-$30k", financing: "maybe", sourcePage: "/estimate/bathroom", status: "new" },
    { _id: oid("estimate", 2), service: "kitchen", name: "Test Customer 47", phone: "(516) 555-0147", email: "customer47@example.test", address: "140 Maple Demo Ave, Garden City NY 11530", contactPref: "phone", bestTime: "mornings", notes: "Keep the layout, new cabinets and counters. (preview)", estimateLow: 32000, estimateHigh: 48000, kitchenScope: "full", kitchenSize: "large", kitchenItems: ["cabinets", "countertops", "backsplash", "lighting"], kitchenFinish: "premium", kitchenLayout: "no", kitchenPlumbing: "no", timeline: "planning", budgetRange: "$40k-$60k", financing: "no", sourcePage: "/estimate/kitchen", status: "contacted" },
    { _id: oid("estimate", 3), service: "roofing", name: "Test Customer 48", phone: "(516) 555-0148", email: "customer48@example.test", address: "9 Birch Demo Ln, Babylon NY 11702", contactPref: "call", bestTime: "any", notes: "Leak over the porch after the last storm. (preview)", estimateLow: 14000, estimateHigh: 21000, roofScope: "replacement", roofSize: "medium", roofMaterial: "asphalt", roofUrgency: "storm", roofInsurance: "maybe", roofFinish: "standard", timeline: "asap", budgetRange: "$15k-$20k", financing: "yes", sourcePage: "/estimate/roofing", status: "qualified" },
  ]);
  bump("estimate_leads", estimateLeads.length);

  /* ---------------- projects ---------------- */
  const fakeReq = { user: { id: String(owner._id) }, authUser: owner, accessUser: owner, headers: {}, ip: "127.0.0.1" };
  const projects = {};
  // P1: converted from the roofing lead through the real conversion.
  ({ project: projects.lead } = await convertLeadToProject({ source: resolveLeadSource("estimate"), leadId: estimateLeads[2]._id, body: {}, req: fakeReq }));

  const projectBase = (n, customerNo, type, status, extra = {}) => {
    const c = C(customerNo);
    const a = c.addresses[0];
    const formatted = `${a.line1}, ${a.city}, NY ${a.zip}`;
    return {
      _id: oid("project", n),
      status,
      customerName: c.name,
      phone: c.phone,
      email: c.email,
      address: formatted,
      customerId: c._id,
      addressId: a._id,
      customerSnapshot: { fullName: c.name, email: c.email, phone: c.phone },
      propertySnapshot: { addressLine1: a.line1, city: a.city, state: "NY", postalCode: a.zip, formattedAddress: formatted },
      projectType: type,
      notes: `${type} project for ${c.name}. Invented preview data.`,
      statusHistory: [{ from: "", to: "Lead", at: addDays(now, -40), actorId: owner._id, actorName: owner.name, reason: "Created", source: "manual" }, ...(status !== "Lead" ? [{ from: "Lead", to: status, at: addDays(now, -20), actorId: owner._id, actorName: owner.name, reason: "", source: "manual" }] : [])],
      createdAt: addDays(now, -40),
      ...extra,
    };
  };
  let docSeq = 0;
  async function storedPdf(key, title, lines) {
    const body = await pdfBuffer(title, lines);
    await s3.putPrivateObject({ Key: key, Body: body, ContentType: "application/pdf" });
    bump("pdfs");
    return { key, fileName: key.split("/").pop(), size: body.length };
  }
  async function agreement(project, n, { status, priceCents, depositCents, schedule, signedDaysAgo = 10, emailedDaysAgo = 5 }) {
    docSeq += 1;
    const number = `PV${String(1000 + n)}`;
    const keyBase = `private/admin/contracts/${number}`;
    const generated = await storedPdf(`${keyBase}/generated.pdf`, `Home Improvement Agreement ${number}`, [project.customerName, project.address, `Contract price $${(priceCents / 100).toLocaleString()}`]);
    const contract = await Contract.create({
      _id: oid("contract", n),
      contractNumber: number,
      version: 1,
      current: true,
      projectId: project._id,
      status,
      customerSnapshot: { fullName: project.customerName, email: project.email, phone: project.phone },
      propertySnapshot: { address: project.address, projectNumber: project.projectNumber },
      workType: project.projectType,
      projectDescription: `${project.projectType} renovation (preview)`,
      scopeText: "Demolition, rough-in, finishes and cleanup as described in the attached scope. Invented preview text.",
      originalContractPriceCents: priceCents,
      totalPriceCents: priceCents,
      adjustedContractPriceCents: priceCents,
      depositAmountCents: depositCents,
      remainingBalanceCents: priceCents - depositCents,
      paymentSchedule: schedule,
      dates: { contractDate: addDays(now, -(signedDaysAgo + 2)) },
      generatedPdf: { ...generated, generatedAt: addDays(now, -(signedDaysAgo + 2)) },
      ...(status === "Emailed" || status === "Signed" ? { emailHistory: [{ recipient: project.email, subject: `Your agreement ${number}`, sentAt: addDays(now, -emailedDaysAgo) }] } : {}),
      ...(status === "Signed" ? { signedPdf: { ...(await storedPdf(`${keyBase}/signed.pdf`, `Executed Agreement ${number}`, ["Signed electronically (preview)"])), uploadedAt: addDays(now, -signedDaysAgo) } } : {}),
      createdBy: owner._id,
    });
    const signer = { role: "CUSTOMER", name: project.customerName, email: project.email, order: 1 };
    const frozen = { ...(await storedPdf(`${keyBase}/frozen.pdf`, `Agreement ${number} (as sent)`, [])), sha256: crypto.createHash("sha256").update(number).digest("hex"), documentVersion: 1, frozenAt: addDays(now, -emailedDaysAgo) };
    let signToken = null;
    if (status === "Emailed") {
      signToken = `preview-sign-${number.toLowerCase()}`;
      await ESignature.create({ _id: oid("sig", n), projectId: project._id, documentType: "CONTRACT", documentId: contract._id, documentNumber: number, provider: "native", signingMode: "REMOTE", status: "Sent", signers: [{ ...signer, status: "Pending" }], sentAt: addDays(now, -emailedDaysAgo), frozenDocument: frozen, signingToken: { hash: hashToken(signToken), state: "active", issuedAt: addDays(now, -emailedDaysAgo), expiresAt: addDays(now, 25), sendCount: 1, lastSentAt: addDays(now, -emailedDaysAgo) } });
    } else if (status === "Signed") {
      await ESignature.create({ _id: oid("sig", n), projectId: project._id, documentType: "CONTRACT", documentId: contract._id, documentNumber: number, provider: "native", signingMode: "REMOTE", status: "Completed", signers: [{ ...signer, status: "Signed", viewedAt: addDays(now, -signedDaysAgo - 0.1), signedAt: addDays(now, -signedDaysAgo) }], sentAt: addDays(now, -emailedDaysAgo), completedAt: addDays(now, -signedDaysAgo), consent: { disclosureVersion: "PIH-ESIGN-DISCLOSURE-2026-001", acceptedAt: addDays(now, -signedDaysAgo) }, frozenDocument: frozen, executedPdf: { ...(await storedPdf(`${keyBase}/executed.pdf`, `Executed Agreement ${number}`, [])), storedAt: addDays(now, -signedDaysAgo) }, certificatePdf: { ...(await storedPdf(`${keyBase}/certificate.pdf`, `Signing certificate ${number}`, [])), storedAt: addDays(now, -signedDaysAgo) }, executedSha256: crypto.createHash("sha256").update(`${number}-executed`).digest("hex"), signingToken: { hash: hashToken(`completed-${number}`), state: "completed", issuedAt: addDays(now, -emailedDaysAgo) } });
    }
    bump("agreements");
    return { contract, signToken };
  }
  async function invoice(project, contract, n, { label, amountCents, dueDaysFromNow, payments = [], sentDaysAgo = 10, category = "Contract work" }) {
    const inv = await Invoice.create({
      _id: oid("invoice", n),
      invoiceNumber: `PV${String(5000 + n)}`,
      projectId: project._id,
      status: "Sent",
      sentAt: addDays(now, -sentDaysAgo),
      source: "contract",
      contractId: contract._id,
      customerSnapshot: { fullName: project.customerName, email: project.email, phone: project.phone },
      propertySnapshot: { address: project.address, formattedAddress: project.address },
      projectSnapshot: { projectNumber: project.projectNumber, workType: project.projectType, projectDescription: project.notes },
      contractSnapshot: { contractNumber: contract.contractNumber, finalContractPriceCents: contract.totalPriceCents },
      lineItems: [{ description: label, quantity: 1, unitPriceCents: amountCents, amountCents, category }],
      dates: { invoiceDate: addDays(now, -sentDaysAgo), dueDate: addDays(now, dueDaysFromNow) },
      payments: payments.map((p) => ({ amountCents: p.amountCents, paymentDate: addDays(now, -p.daysAgo), method: p.method || "Check", reference: p.reference || "", note: "Recorded in the preview seed", recordedBy: owner._id, recordedByEmail: owner.email, provider: "manual" })),
      paymentInstructions: "Checks payable to Premium Island Homes Inc.",
      createdBy: owner._id,
    });
    bump("invoices");
    return inv;
  }
  const schedule3 = (total, deposit) => [
    { label: "Deposit", amountCents: deposit, dueCondition: "Upon signing", order: 0 },
    { label: "Rough-in complete", amountCents: Math.round((total - deposit) / 2), dueCondition: "When rough-in passes inspection", order: 1 },
    { label: "Final", amountCents: total - deposit - Math.round((total - deposit) / 2), dueCondition: "At substantial completion", order: 2 },
  ];

  // P2: agreement emailed, awaiting signature.
  const p2 = await Project.create(projectBase(2, 23, "Bathroom", "Estimate Sent"));
  const { signToken } = await agreement(p2, 2, { status: "Emailed", priceCents: 2450000, depositCents: 500000, schedule: schedule3(2450000, 500000), emailedDaysAgo: 5 });
  projects.awaiting = p2;

  // P3: signed, no deposit invoice yet.
  const p3 = await Project.create(projectBase(3, 24, "Kitchen", "Won"));
  await agreement(p3, 3, { status: "Signed", priceCents: 3880000, depositCents: 800000, schedule: schedule3(3880000, 800000), signedDaysAgo: 3, emailedDaysAgo: 6 });
  projects.signedNoDeposit = p3;

  // P4: in progress, an executed change order (+ one awaiting signature), deposit paid, milestone partially paid.
  const p4 = await Project.create(projectBase(4, 25, "Bathroom", "In Progress", { scheduledStart: addDays(now, -9), scheduledEnd: addDays(now, 12), assignedFixterIds: [general._id, fixter1._id] }));
  const { contract: c4 } = await agreement(p4, 4, { status: "Signed", priceCents: 2960000, depositCents: 600000, schedule: schedule3(2960000, 600000), signedDaysAgo: 25, emailedDaysAgo: 28 });
  await ChangeOrder.create({
    _id: oid("co", 1), changeOrderNumber: `CO-${c4.contractNumber}-01`, sequence: 1, projectId: p4._id, contractId: c4._id, status: "Executed", title: "Replace rotted subfloor under the tub",
    customerSnapshot: { fullName: p4.customerName, email: p4.email }, propertySnapshot: { address: p4.address, projectNumber: p4.projectNumber }, contractSnapshot: { contractNumber: c4.contractNumber, contractDate: c4.dates.contractDate, originalContractAmountCents: c4.totalPriceCents },
    contractAmountBeforeChangeCents: c4.totalPriceCents, lines: [{ description: "Remove and replace 40 sq ft of rotted subfloor (preview)", direction: "add", amountCents: 180000 }],
    // Executed change orders are locked, so the model does not compute their totals on create.
    netAdjustmentCents: 180000, newContractAmountCents: c4.totalPriceCents + 180000,
    generatedPdf: { ...(await storedPdf(`private/admin/change-orders/CO-${c4.contractNumber}-01/generated.pdf`, `Change Order CO-${c4.contractNumber}-01`, [])), generatedAt: addDays(now, -12) },
    executedPdf: { ...(await storedPdf(`private/admin/change-orders/CO-${c4.contractNumber}-01/executed.pdf`, `Executed Change Order CO-${c4.contractNumber}-01`, [])), uploadedAt: addDays(now, -10), source: "native_esign" },
    sentAt: addDays(now, -12), executedAt: addDays(now, -10), createdBy: owner._id,
  });
  await ChangeOrder.create({
    _id: oid("co", 2), changeOrderNumber: `CO-${c4.contractNumber}-02`, sequence: 2, projectId: p4._id, contractId: c4._id, status: "Sent", title: "Add a niche and a grab bar",
    customerSnapshot: { fullName: p4.customerName, email: p4.email }, propertySnapshot: { address: p4.address, projectNumber: p4.projectNumber }, contractSnapshot: { contractNumber: c4.contractNumber, contractDate: c4.dates.contractDate, originalContractAmountCents: c4.totalPriceCents },
    contractAmountBeforeChangeCents: c4.totalPriceCents + 180000, lines: [{ description: "Tile niche in the shower wall and one stainless grab bar (preview)", direction: "add", amountCents: 65000 }],
    generatedPdf: { ...(await storedPdf(`private/admin/change-orders/CO-${c4.contractNumber}-02/generated.pdf`, `Change Order CO-${c4.contractNumber}-02`, [])), generatedAt: addDays(now, -2) },
    sentAt: addDays(now, -2), createdBy: owner._id,
  });
  bump("change_orders", 2);
  const dep4 = await invoice(p4, c4, 1, { label: "Deposit", amountCents: 600000, dueDaysFromNow: -20, sentDaysAgo: 25, payments: [{ amountCents: 600000, daysAgo: 24, method: "Check", reference: "Check 1042" }] });
  const ms4 = await invoice(p4, c4, 2, { label: "Rough-in complete", amountCents: 1180000, dueDaysFromNow: 7, sentDaysAgo: 7, payments: [{ amountCents: 500000, daysAgo: 3, method: "Zelle", reference: "Zelle (preview)" }] });
  await Project.updateOne({ _id: p4._id }, { $set: { billingClaims: [{ claimKey: `deposit:${c4._id}`, kind: "deposit", contractId: c4._id, invoiceId: dep4._id, claimedAt: addDays(now, -25), claimedBy: owner._id }, { claimKey: `milestone:${c4._id}:1`, kind: "milestone", scheduleIndex: 1, contractId: c4._id, invoiceId: ms4._id, claimedAt: addDays(now, -7), claimedBy: owner._id }] } });
  projects.inProgress = p4;

  // P5: substantially complete, punch list open, final invoice overdue.
  const p5 = await Project.create(projectBase(5, 31, "Kitchen", "In Progress", { scheduledStart: addDays(now, -50), scheduledEnd: addDays(now, -6), assignedFixterIds: [general._id], substantialCompletionAt: addDays(now, -6), substantialCompletionBy: owner._id, warrantyEndsAt: addMonths(addDays(now, -6), 12), warrantyTermsVersion: "PIH-NY-HI-2026-004" }));
  const { contract: c5 } = await agreement(p5, 5, { status: "Signed", priceCents: 4200000, depositCents: 900000, schedule: schedule3(4200000, 900000), signedDaysAgo: 60, emailedDaysAgo: 62 });
  const i51 = await invoice(p5, c5, 3, { label: "Deposit", amountCents: 900000, dueDaysFromNow: -55, sentDaysAgo: 60, payments: [{ amountCents: 900000, daysAgo: 58, method: "ACH / Bank Transfer" }] });
  const i52 = await invoice(p5, c5, 4, { label: "Rough-in complete", amountCents: 1650000, dueDaysFromNow: -25, sentDaysAgo: 32, payments: [{ amountCents: 1650000, daysAgo: 27, method: "Check", reference: "Check 2210" }] });
  const i53 = await invoice(p5, c5, 5, { label: "Final", amountCents: 1650000, dueDaysFromNow: -2, sentDaysAgo: 6 });
  await Project.updateOne(
    { _id: p5._id },
    {
      $set: {
        billingClaims: [
          { claimKey: `deposit:${c5._id}`, kind: "deposit", contractId: c5._id, invoiceId: i51._id, claimedAt: addDays(now, -60), claimedBy: owner._id },
          { claimKey: `milestone:${c5._id}:1`, kind: "milestone", scheduleIndex: 1, contractId: c5._id, invoiceId: i52._id, claimedAt: addDays(now, -32), claimedBy: owner._id },
          { claimKey: `milestone:${c5._id}:2`, kind: "milestone", scheduleIndex: 2, contractId: c5._id, invoiceId: i53._id, claimedAt: addDays(now, -6), claimedBy: owner._id },
        ],
        punchList: [
          { text: "Adjust the pantry door so it closes flush (preview)", done: true, doneAt: addDays(now, -3), doneBy: general._id, createdAt: addDays(now, -6), createdBy: owner._id },
          { text: "Touch up paint above the range hood (preview)", done: false, createdAt: addDays(now, -6), createdBy: owner._id },
          { text: "Replace the scratched cabinet pull, third drawer (preview)", done: false, createdAt: addDays(now, -5), createdBy: owner._id },
        ],
      },
    }
  );
  projects.substantiallyComplete = p5;
  // Link P4's site visit to a completed booking of the same customer if there is one, else the first past booking.
  const siteVisit = created.find((b) => String(b.user) === String(C(25)._id)) || created.find((b) => b.status === "Completed");
  if (siteVisit) {
    await Project.updateOne({ _id: p4._id }, { $set: { linkedBookingIds: [siteVisit._id], siteVisitBookingId: siteVisit._id } });
    await Booking.updateOne({ _id: siteVisit._id }, { $set: { projectId: p4._id } });
  }
  bump("projects", 5);

  /* ---------------- blacklist ---------------- */
  const blocked = C(38);
  const lifted = C(39);
  await Blacklist.create({ user: blocked._id, userId: blocked.userId, name: blocked.name, email: blocked.email, phone: blocked.phone, address: blocked.addresses[0].line1, city: blocked.addresses[0].city, state: "NY", zip: blocked.addresses[0].zip, reason: "Repeated no-shows and abusive calls to the office (preview)", createdAt: addDays(now, -15), blockedBy: owner._id, blockedByName: owner.name });
  await Blacklist.create({ user: lifted._id, userId: lifted.userId, name: lifted.name, email: lifted.email, phone: lifted.phone, address: lifted.addresses[0].line1, city: lifted.addresses[0].city, state: "NY", zip: lifted.addresses[0].zip, reason: "Disputed a charge (preview)", createdAt: addDays(now, -50), blockedBy: owner._id, blockedByName: owner.name, liftedAt: addDays(now, -20), liftedBy: owner._id, liftedByName: owner.name, liftReason: "Resolved by phone; card updated (preview)" });
  bump("blacklist", 2);

  /* ---------------- consent events ---------------- */
  for (const n of [1, 2, 5, 7, 10, 15]) {
    const c = C(n);
    const at = new Date(c.createdAt);
    const events = [{ user: c._id, channel: "sms", purpose: "service", action: "granted", source: "signup", consentVersion: "2026-10", consentText: "Texts about my appointments. Msg & data rates may apply. Reply STOP to opt out.", phone: c.phone, method: "web_form", at }];
    if (n % 5 === 0) events.push({ user: c._id, channel: "sms", purpose: "marketing", action: "granted", source: "signup_checkbox", consentVersion: "2026-10", consentText: "Occasional offers by text. Reply STOP to opt out.", phone: c.phone, method: "web_form", at });
    if (n === 2) events.push({ user: c._id, channel: "email", purpose: "marketing", action: "unsubscribed", source: "unsubscribe_link", email: c.email, at: addDays(now, -8) });
    if (n === 7) events.push({ user: c._id, channel: "sms", purpose: "all", action: "stop", source: "sms_stop", phone: c.phone, detail: "Replied STOP (preview)", at: addDays(now, -6) });
    await ConsentEvent.create(events);
    bump("consent_events", events.length);
  }

  /* ---------------- email + sms history ---------------- */
  let smsSeq = 0;
  for (const b of created.slice(0, 30)) {
    const template = b.status === "Completed" ? "booking_completed" : b.status === "Canceled" ? "booking_canceled" : b.status === "Confirmed" ? "booking_confirmed" : "booking_created";
    const sentAt = b.status === "Completed" ? b.completedAt || b.date : addDays(b.date, -2);
    await EmailLog.create({ templateKey: template, subject: `${template.replace(/_/g, " ")} - ${b.bookingNumber} (preview)`, recipientEmail: b.email, recipientName: b.name, customerEmail: b.email, customerName: b.name, userId: String(b.user || ""), bookingId: b._id, bookingNumber: b.bookingNumber, source: "previewSeed", emailType: "transactional", status: "sent", sentAt, provider: "preview-seed", providerMessageId: `<seed-${b.bookingNumber}@preview.local>`, createdAt: sentAt });
    bump("email_logs");
    if (b.status !== "Pending" && b.phone && smsSeq < 15) {
      smsSeq += 1;
      await SmsMessage.create({ user: b.user, userId: b.userId, toPhone: b.phone, recipientName: b.name, booking: b._id, bookingNumber: b.bookingNumber, notificationType: b.status === "Completed" ? "booking_completed" : "booking_confirmed", channelClass: "transactional", body: `Profixter: your visit ${b.bookingNumber} is ${b.status.toLowerCase()}. (preview text)`, segments: 1, provider: "twilio", providerMessageSid: `SMseed${String(smsSeq).padStart(28, "0")}`, providerStatus: "delivered", status: "delivered", sentAt, deliveredAt: sentAt, attempts: 1, dedupeKey: `preview-seed:${b.bookingNumber}:${b.status}`, source: "previewSeed", createdAt: sentAt });
      bump("sms_messages");
    }
  }
  await EmailLog.create({ templateKey: "booking_confirmed", subject: "Your visit is confirmed (preview)", recipientEmail: C(12).email, recipientName: C(12).name, customerEmail: C(12).email, customerName: C(12).name, userId: String(C(12)._id), source: "previewSeed", emailType: "transactional", status: "failed", failedAt: addDays(now, -1), provider: "preview-seed", errorMessage: "Mailbox unavailable (preview)", errorCode: "EENVELOPE", responseCode: "550", createdAt: addDays(now, -1) });
  bump("email_logs");

  /* ---------------- activity log ---------------- */
  const activity = [
    { action: "Booking Status Changed", entityType: "Booking", entityId: String(created[0]?._id || ""), entityName: created[0]?.bookingNumber || "", details: { from: "Confirmed", to: "Completed" }, daysAgo: 13 },
    { action: "Customer Note Added", entityType: "User", entityId: String(C(2)._id), entityName: C(2).name, details: { preview: true }, daysAgo: 2 },
    { action: "Customer Blocked", entityType: "User", entityId: String(blocked._id), entityName: blocked.name, details: { reason: "Repeated no-shows and abusive calls to the office (preview)" }, daysAgo: 15 },
    { action: "Customer Unblocked", entityType: "User", entityId: String(lifted._id), entityName: lifted.name, details: { reason: "Resolved by phone; card updated (preview)" }, daysAgo: 20 },
    { action: "Membership Cancellation Scheduled", entityType: "Subscription", entityId: String(subsByCustomer.get(17)[0]._id), entityName: C(17).name, details: { mode: "date", after: { cancelAt: subsByCustomer.get(17)[0].cancellationDate } }, daysAgo: 4 },
    { action: "Complimentary Membership Granted", entityType: "Subscription", entityId: String(subsByCustomer.get(22)[0]._id), entityName: C(22).name, details: { plan: "plus", reason: "Thank-you for referring three neighbours (preview)" }, daysAgo: 30 },
    { action: "Agreement Emailed", entityType: "Contract", entityId: String(oid("contract", 2)), entityName: "PV1002", details: { to: p2.email }, daysAgo: 5 },
    { action: "Invoice Payment Recorded", entityType: "Invoice", entityId: String(ms4._id), entityName: ms4.invoiceNumber, details: { amountCents: 500000, method: "Zelle" }, daysAgo: 3 },
    { action: "Promotion Popup Updated", entityType: "PromotionPopup", entityId: "active", entityName: "Homepage popup", details: { enabled: true }, daysAgo: 1 },
  ];
  for (const entry of activity) {
    await AdminActivityLog.create({ action: entry.action, entityType: entry.entityType, entityId: entry.entityId, entityName: entry.entityName, actorUserId: owner._id, actorName: owner.name, actorRole: "admin", details: entry.details, ipAddress: "127.0.0.1", createdAt: addDays(now, -entry.daysAgo) });
    bump("activity_logs");
  }

  /* ---------------- recent work ---------------- */
  const workPhotos = [
    { title: "New vanity light", category: "light-fixture-installation", status: "published", uploaderType: "admin", featured: true },
    { title: "Drywall patch, before paint", category: "drywall-repair", status: "published", uploaderType: "admin" },
    { title: "Mounted 65-inch TV", category: "tv-mounting", status: "published", uploaderType: "admin" },
    { title: "Fence gate rehung", category: "general-handyman", status: "pending_review", uploaderType: "fixter", by: fixter1 },
    { title: "Bathtub re-caulked", category: "caulking", status: "pending_review", uploaderType: "fixter", by: fixter2 },
    { title: "Closet shelving", category: "general-handyman", status: "library", uploaderType: "admin" },
  ];
  for (let i = 0; i < workPhotos.length; i++) {
    const w = workPhotos[i];
    const base = `uploads/recent-work/preview-${i + 1}`;
    const display = await photoBuffer({ title: w.title, subtitle: "Recent work (preview)", hue: (i * 55 + 20) % 360, width: 1200, height: 900 });
    const thumb = await photoBuffer({ title: w.title, subtitle: "Recent work (preview)", hue: (i * 55 + 20) % 360, width: 480, height: 360 });
    const displayUrl = await s3.putPublicObject({ Key: `${base}-display.jpg`, Body: display, ContentType: "image/jpeg" });
    const thumbUrl = await s3.putPublicObject({ Key: `${base}-thumb.jpg`, Body: thumb, ContentType: "image/jpeg" });
    await WorkPhoto.create({
      title: w.title,
      caption: `${w.title}. Invented preview photo.`,
      category: w.category,
      thumb: { key: `${base}-thumb.jpg`, url: thumbUrl, width: 480, height: 360, bytes: thumb.length },
      display: { key: `${base}-display.jpg`, url: displayUrl, width: 1200, height: 900, bytes: display.length },
      full: { key: `${base}-display.jpg`, url: displayUrl, width: 1200, height: 900, bytes: display.length },
      status: w.status,
      publishedAt: w.status === "published" ? addDays(now, -(i + 2)) : null,
      firstPublishedAt: w.status === "published" ? addDays(now, -(i + 2)) : null,
      featured: Boolean(w.featured),
      sortOrder: i,
      uploaderType: w.uploaderType,
      uploadedByUserId: (w.by || owner)._id,
      uploadedByName: (w.by || owner).name,
      uploadedByRole: w.by ? "employee" : "admin",
      publicLocation: TOWNS[i % TOWNS.length].city,
      createdAt: addDays(now, -(i + 3)),
    });
    bump("recent_work");
  }

  /* ---------------- promotion popup ---------------- */
  await PromotionPopup.create({ singletonKey: "active", enabled: true, eyebrow: "Profixter update", title: "Fall tune-up week (preview)", message: "Book any visit this week and we will check your smoke detectors for free. Invented preview text.", promoCode: "PREVIEW10", ctaText: "Book a visit", ctaUrl: "/book", secondaryText: "See plans", secondaryUrl: "/membership/plans", startAt: addDays(now, -2), endAt: addDays(now, 12), target: "homepage", internalNote: "Preview data", updatedBy: owner._id });

  /* ---------------- meta ---------------- */
  await mongoose.connection.collection("preview_meta").updateOne(
    { _id: "seed" },
    { $set: { version: SEED_VERSION, seededAt: now, counts, warnings, engineFallbacks, signUrlPath: signToken ? `/sign/${signToken}` : null, projects: Object.fromEntries(Object.entries(projects).map(([k, v]) => [k, String(v._id)])) } },
    { upsert: true }
  );

  if (engineFallbacks.length) log(`[preview seed] ${engineFallbacks.length} booking(s) inserted without the engine: ${engineFallbacks.join("; ")}`);
  for (const w of warnings) log(`[preview seed] warning: ${w}`);
  return { counts, warnings, engineFallbacks, projects, signToken };
}

/** What the fake Stripe needs, read from the preview DB (rebuilt on each start). */
async function loadStripeData() {
  const User = req("models/User");
  const Subscription = req("models/Subscription");
  const VisitEntitlement = req("models/VisitEntitlement");
  const Tip = req("models/Tip");
  const sm = req("utils/subscriptionManagement");
  const users = await User.find({ stripeCustomerId: { $nin: [null, ""] } }).select("stripeCustomerId email name phone userId createdAt").lean();
  const subs = await Subscription.find({ stripeSubscriptionId: { $nin: [null, ""] } }).lean();
  const ents = await VisitEntitlement.find({ stripePaymentIntentId: { $nin: [null, ""] } }).lean();
  const tips = await Tip.find({}).select("stripePaymentIntentId amountCents receivedAt").lean();
  return {
    catalog: sm.PLAN_CATALOG,
    customers: users.map((u) => ({ id: u.stripeCustomerId, email: u.email, name: u.name, phone: u.phone, userId: u.userId, createdAt: u.createdAt })),
    subscriptions: subs.map((s) => ({
      id: s.stripeSubscriptionId,
      itemId: s.stripeSubscriptionItemId,
      customer: s.stripeCustomerId,
      status: s.status,
      priceId: s.stripePriceId || sm.PLAN_CATALOG[s.subscriptionType]?.[s.billingCycle || "monthly"]?.stripePriceId,
      startDate: s.startDate,
      currentPeriodStart: s.currentPeriodStart,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      cancelAt: s.cancelAtPeriodEnd ? s.currentPeriodEnd : s.cancellationDate && !["canceled", "expired"].includes(s.status) ? s.cancellationDate : null,
      endedAt: ["canceled", "expired"].includes(s.status) ? s.cancellationDate || s.currentPeriodEnd : null,
      trialStart: s.trialStart,
      trialEnd: s.trialEnd,
      metadata: { userId: String(s.user), addressId: String(s.addressId), plan: s.subscriptionType, billingCycle: s.billingCycle || "monthly", localSubscriptionId: String(s._id) },
    })),
    paymentIntents: [
      ...ents.map((e) => ({ id: e.stripePaymentIntentId, amountCents: e.priceCents, at: e.purchasedAt, description: "One-Time Visit (preview)", metadata: { entitlementId: String(e._id) } })),
      ...tips.filter((t) => t.stripePaymentIntentId).map((t) => ({ id: t.stripePaymentIntentId, amountCents: t.amountCents, at: t.receivedAt, description: "Tip (preview)" })),
    ],
  };
}

module.exports = { ACCOUNTS, SEED_VERSION, loadStripeData, oid, seedPreview };
