const crypto = require("crypto");
const { OutreachRecipient, OutreachWave } = require("../../models/Outreach");
const User = require("../../models/User");
const { ghl } = require("../ghl/client");
const { normalizeZip, isZipInServiceArea, countyForZip } = require("../serviceArea");
const { normalizeEmail, normalizePhone } = require("../identity");

/**
 * Builds the postal-mail audience from GoHighLevel, and reports on it.
 *
 * ELIGIBLE for mail = inside the Nassau/Suffolk ZIP allowlist, has a street
 * address, not an obvious junk/test record, not already a Profixter customer,
 * has never asked to stop (a STOP reply, a "permanent" DND, or an opt-out tag
 * - anyone who said no is not mailed either), and one per household.
 * Carrier-error SMS DND (landlines, dead numbers) says nothing about mail and
 * does not exclude.
 */
const COLD_TAG = "cold_prospects_2026";
const OPT_OUT_TAGS = ["do_not_contact", "ai_opted_out", "unsubscribed"];

const hash = (v) => (v ? crypto.createHash("sha256").update(String(v)).digest("hex") : null);
const householdOf = (address1, zip) =>
  address1 && zip ? `${String(address1).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${zip}` : null;

function newCode() {
  return crypto.randomBytes(4).toString("base64url").replace(/[-_]/g, "x").slice(0, 6).toLowerCase();
}

async function customerHashes() {
  const users = await User.find({}).select("email phone").lean();
  return {
    emails: new Set(users.map((u) => hash(normalizeEmail(u.email))).filter(Boolean)),
    phones: new Set(users.map((u) => hash(normalizePhone(u.phone))).filter(Boolean)),
  };
}

function classify(contact, { customers }) {
  const zip = normalizeZip(contact.postalCode || contact.postal_code || "");
  const tags = (contact.tags || []).map((t) => String(t).toLowerCase());
  const smsDnd = contact.dndSettings?.SMS || contact.dndSettings?.sms || {};
  const name = `${contact.firstName || contact.firstNameRaw || ""} ${contact.lastName || contact.lastNameRaw || ""}`.toLowerCase();
  if (!zip || zip === "00501" || /\btest\b|\bdummy\b|\bsample\b/.test(name)) return "junk_record";
  if (!isZipInServiceArea(zip)) return "outside_service_area";
  if (!String(contact.address1 || "").trim()) return "no_street_address";
  if (contact.dnd === true || String(smsDnd.status || "") === "permanent" || /stop/i.test(String(smsDnd.message || "")) || tags.some((t) => OPT_OUT_TAGS.includes(t))) {
    return "asked_to_stop";
  }
  const eh = hash(normalizeEmail(contact.email));
  const ph = hash(normalizePhone(contact.phone));
  if ((eh && customers.emails.has(eh)) || (ph && customers.phones.has(ph))) return "existing_customer";
  return null;
}

/**
 * Page through the cold-tagged contacts and upsert recipients. Read-only on
 * GoHighLevel. Resumable: pass the returned `searchAfter` to continue.
 */
async function syncAudience({ maxPages = 50, searchAfter, env, fetchImpl, now = new Date() } = {}) {
  const customers = await customerHashes();
  let cursor = searchAfter;
  let pages = 0;
  let seen = 0;
  while (pages < maxPages) {
    const page = await ghl.searchContacts({ filters: [{ field: "tags", operator: "contains", value: COLD_TAG }], pageLimit: 100, searchAfter: cursor, env, fetchImpl });
    const contacts = page?.contacts || [];
    if (!contacts.length) {
      cursor = null;
      break;
    }
    for (const c of contacts) {
      const zip = normalizeZip(c.postalCode || "") || "";
      const reason = classify(c, { customers });
      await OutreachRecipient.updateOne(
        { ghlContactId: String(c.id) },
        {
          $set: {
            firstName: String(c.firstNameRaw || c.firstName || "").slice(0, 40),
            lastName: String(c.lastNameRaw || c.lastName || "").slice(0, 60),
            address1: String(c.address1 || "").slice(0, 120),
            city: String(c.city || "").slice(0, 60),
            state: String(c.state || "NY").slice(0, 20),
            zip,
            county: zip ? countyForZip(zip) || null : null,
            householdKey: householdOf(c.address1, zip),
            emailHash: hash(normalizeEmail(c.email)),
            phoneHash: hash(normalizePhone(c.phone)),
            eligible: !reason,
            excludedReason: reason,
            syncedAt: now,
          },
          $setOnInsert: { code: newCode(), waves: [] },
        },
        { upsert: true }
      );
      seen += 1;
    }
    cursor = contacts[contacts.length - 1]?.searchAfter || null;
    pages += 1;
    if (!cursor) break;
  }
  await dedupeHouseholds();
  return { pages, seen, searchAfter: cursor, done: !cursor };
}

/** One recipient per household: the earliest stays eligible. */
async function dedupeHouseholds() {
  const dups = await OutreachRecipient.aggregate([
    { $match: { eligible: true, householdKey: { $ne: null } } },
    { $sort: { createdAt: 1 } },
    { $group: { _id: "$householdKey", ids: { $push: "$_id" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]);
  for (const d of dups) {
    await OutreachRecipient.updateMany({ _id: { $in: d.ids.slice(1) } }, { $set: { eligible: false, excludedReason: "same_household" } });
  }
  return dups.length;
}

/** Aggregates only - what agents and the Command Center see. */
async function audienceSummary({ now = new Date() } = {}) {
  const ninetyDays = new Date(now - 90 * 864e5);
  const [total, eligible, excluded, byCity, byCounty, fresh] = await Promise.all([
    OutreachRecipient.countDocuments({}),
    OutreachRecipient.countDocuments({ eligible: true }),
    OutreachRecipient.aggregate([{ $match: { eligible: false } }, { $group: { _id: "$excludedReason", n: { $sum: 1 } } }]),
    OutreachRecipient.aggregate([
      { $match: { eligible: true } },
      { $group: { _id: { city: "$city", zip: "$zip" }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
      { $limit: 40 },
    ]),
    OutreachRecipient.aggregate([{ $match: { eligible: true } }, { $group: { _id: "$county", n: { $sum: 1 } } }]),
    OutreachRecipient.countDocuments({ eligible: true, $or: [{ lastMailedAt: null }, { lastMailedAt: { $lt: ninetyDays } }] }),
  ]);
  return {
    synced: total,
    eligible,
    mailableNow: fresh,
    excluded: Object.fromEntries(excluded.map((e) => [e._id || "unknown", e.n])),
    byCounty: Object.fromEntries(byCounty.map((c) => [c._id || "unknown", c.n])),
    topZips: byCity.map((c) => ({ city: c._id.city, zip: c._id.zip, eligible: c.n })),
  };
}

/** First free visits from people who arrived through a wave's codes. */
async function waveResults(key) {
  const Booking = require("../../models/Booking");
  const users = await User.find({ "attribution.utmContent": new RegExp(`^${key}-`) }).select("_id createdAt").lean();
  const ids = users.map((u) => u._id);
  const firstVisits = ids.length ? await Booking.countDocuments({ user: { $in: ids }, isFreeFirstVisit: true }) : 0;
  return { registrations: users.length, firstFreeVisits: firstVisits };
}

module.exports = { COLD_TAG, audienceSummary, classify, dedupeHouseholds, householdOf, syncAudience, waveResults };
