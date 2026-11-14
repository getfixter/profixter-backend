/*
 * PREVIEW ONLY: invented sales-desk data for the local preview stack, written
 * through the real sales functions (so commissions, the bonus and statements
 * are computed exactly as in production). Runs once, when the preview has no
 * Telemarketer yet. Fake people only; nothing is charged or sent.
 */
const path = require("path");

const BACKEND = path.join(__dirname, "..", "..");
const req = (p) => require(path.join(BACKEND, p));

const TELE = { email: "tele@preview.test", password: "preview-tele-1", name: "Tess Telemarketer" };
const TELE2 = { email: "tele2@preview.test", password: "preview-tele-2", name: "Theo Telemarketer" };

async function seedSales({ log = console.log, now = new Date() } = {}) {
  const bcrypt = require(require.resolve("bcryptjs", { paths: [BACKEND] }));
  const User = req("models/User");
  const S = req("models/Sales");
  const leads = req("utils/sales/leads");
  const credit = req("utils/sales/credit");
  const ledger = req("utils/sales/ledger");
  const time = req("utils/sales/time");
  if (await User.exists({ employeePosition: "Telemarketer" })) return { skipped: true };
  for (const m of Object.values(S)) await m.init();

  const owner = await User.findOne({ role: "admin" });
  const mk = async (a, n) =>
    User.create({ userId: String(10000090 + n), name: a.name, firstName: a.name.split(" ")[0], lastName: a.name.split(" ")[1], email: a.email, phone: `+1631555029${n}`, password: await bcrypt.hash(a.password, 10), role: "employee", employeePosition: "Telemarketer", employeeTitle: "Telemarketer", isActive: true, adminSections: [], adminSectionsVersion: 2, signupMethod: "admin" });
  const tess = await mk(TELE, 1);
  const theo = await mk(TELE2, 2);
  const ownerReq = { accessUser: owner, accessRole: "admin", headers: {}, get: () => "", ip: "127.0.0.1" };
  const asReq = (u) => ({ accessUser: u, accessRole: "employee", headers: {}, get: () => "", ip: "127.0.0.1" });

  const customers = await User.find({ role: { $in: ["customer", null] }, employeePosition: { $in: [null, ""] } }).sort({ userId: 1 }).limit(14);
  const day = 86400000;
  const leadIds = [];
  for (let i = 0; i < 10; i++) {
    const c = customers[i];
    const lead = await leads.createLead(ownerReq, { name: c.name, userId: String(c._id), town: c.addresses?.[0]?.city });
    await leads.assignLead(ownerReq, lead._id, { employeeId: i < 7 ? tess._id : theo._id, reason: "Preview assignment" });
    await S.LeadAssignment.collection.updateOne({ lead: lead._id, endedAt: null }, { $set: { startedAt: new Date(now.getTime() - 25 * day) } });
    leadIds.push(lead._id);
  }
  for (const [n, name, town] of [[1, "Maya Prospect", "Babylon"], [2, "Leo Prospect", "Islip"]]) {
    const lead = await leads.createLead(ownerReq, { name, phone: `631-555-04${String(10 + n)}`, town, note: "From the owner's list (preview)" });
    await leads.assignLead(ownerReq, lead._id, { employeeId: tess._id, reason: "Preview assignment" });
    leadIds.push(lead._id);
  }
  await leads.submitIntake(asReq(tess), { name: "Nora Neighbor", phone: "631-555-0499", town: "Lindenhurst", note: "Met at the hardware store (preview)" });
  await leads.createLead(ownerReq, { name: "Una Assigned", phone: "631-555-0477", town: "Commack" });

  const leadDocs = await S.SalesLead.find({ _id: { $in: leadIds } }).lean();
  const act = async (lead, kind, body, hoursAgo) => {
    await leads.logActivity(asReq(tess), lead, { kind, body }, "telemarketer");
    await S.SalesActivity.collection.updateOne({ lead: lead._id, kind, body }, { $set: { at: new Date(now.getTime() - hoursAgo * 3600000) } });
  };
  await act(leadDocs[0], "attempt", "", 50);
  await act(leadDocs[0], "reached_interested", "Wants the Basic plan; call after 5pm", 30);
  await act(leadDocs[1], "voicemail", "", 20);
  await act(leadDocs[2], "reached_not_interested", "Has a handyman already", 10);
  await leads.createTask(asReq(tess), leadDocs[0], { dueAt: new Date(now.getTime() + 3 * 3600000), kind: "call", note: "After 5pm" }, tess._id);
  await leads.createTask(asReq(tess), leadDocs[1], { dueAt: new Date(now.getTime() - 20 * 3600000), kind: "call", note: "Second try" }, tess._id);
  await leads.createTask(asReq(tess), leadDocs[10], { dueAt: new Date(now.getTime() + 26 * 3600000), kind: "text", note: "Send the free-visit link" }, tess._id);

  // Verified sales (as the Stripe webhook would record them), spread over the last weeks.
  let k = 0;
  const sale = async (userId, daysAgo, { plan = "basic", cycle = "monthly", percentOff = 0, returning = false, kind = "membership_first_paid" } = {}) => {
    k += 1;
    const cat = req("utils/subscriptionManagement").PLAN_CATALOG[plan];
    const regular = Math.round((kind === "full_day_paid" ? 499 : cat[cycle].price) * 100);
    const disc = Math.round((regular * percentOff) / 100);
    const pre = regular - disc;
    const { sale: s } = await credit.recordSale({
      sourceKey: `preview:${k}`,
      kind,
      user: userId,
      identity: "stripe_customer",
      plan: kind === "full_day_paid" ? null : plan,
      cycle: kind === "full_day_paid" ? null : cycle,
      stripe: { subscriptionId: kind === "full_day_paid" ? null : `sub_preview_${k}`, invoiceId: `in_preview_${k}`, chargeId: `ch_preview_${k}` },
      amounts: { regularCents: regular, regularMonthlyCents: kind === "full_day_paid" ? null : Math.round(cat.monthly.price * 100), discountCents: disc, paidPreTaxCents: pre, taxCents: Math.round(pre * 0.08625), amountCents: pre + Math.round(pre * 0.08625) },
      discount: percentOff ? { source: "Welcome offer: 20% off the first payment" } : {},
      returningCustomer: returning,
      paidAt: new Date(now.getTime() - daysAgo * day),
      paidAtSource: "stripe_invoice",
    });
    await credit.creditForSale(s);
    return s;
  };
  const u = leadDocs.map((l) => l.linkedUser);
  await sale(u[3], 12, { percentOff: 20 });
  await sale(u[4], 9, { plan: "plus", cycle: "annual" });
  await sale(u[5], 4);
  await sale(u[5], 2, { kind: "full_day_paid" });
  const back = await sale(u[6], 1, { returning: true });
  await sale(u[7], 6, { plan: "premium" });
  await credit.createRequest(tess, { leadId: leadDocs[6]._id, saleId: back._id, kind: "recovery", explanation: "Former member; rejoined after our two calls this week (preview).", evidence: [{ kind: "ghl_reference", text: "GHL call yesterday 4:10 pm, 7 min" }] });

  // Approve and pay the most recent finished week with entries, for statement history.
  const weeks = (await S.CommissionEntry.distinct("statementWeek")).sort();
  const finished = weeks.filter((w) => time.weekFromStart(w).endsAt <= now);
  if (finished.length) {
    const w = finished[finished.length - 1];
    const batch = await ledger.approveWeek(w, owner);
    for (const line of batch.lines) await ledger.recordPayment(w, line.employee, { paidOn: time.weekFromStart(w).payday, method: "payroll", reference: "PREVIEW" }, owner);
  }
  log(`[preview] sales desk seeded: 2 telemarketers (${TELE.email} / ${TELE.password}), ${leadIds.length + 2} leads`);
  return { tess: String(tess._id), theo: String(theo._id) };
}

module.exports = { seedSales, TELE, TELE2 };
