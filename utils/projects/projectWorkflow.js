/**
 * What stage a renovation project is really in, and what the owner should do
 * next - derived from the authoritative records (agreements, signatures,
 * change orders, invoices, the project's own closeout fields), never from the
 * hand-set status dropdown.
 *
 * The manual status stays exactly what the owner set. The derived stage is
 * shown next to it and never overwrites it.
 *
 * Pure functions over plain objects (buildDerivedStage, buildNextSteps) plus
 * one loader (loadProjectOverview), so the rules are testable without Mongo.
 */

const Project = require("../../models/Project");
const Contract = require("../../models/Contract");
const ChangeOrder = require("../../models/ChangeOrder");
const Invoice = require("../../models/Invoice");
const ESignature = require("../../models/ESignature");
const Booking = require("../../models/Booking");
const { getProjectFinancialSummary } = require("../projectFinancialsService");
const { countsTowardInvoiced, paidOnInvoice } = require("../projectFinancials");

const DAY_MS = 24 * 60 * 60 * 1000;
/** An agreement or change order unsigned this long is worth a nudge. */
const AWAITING_SIGNATURE_NUDGE_DAYS = 3;

const STAGES = Object.freeze({
  lead: "Lead",
  proposal_issued: "Proposal issued",
  signed: "Signed",
  deposit_paid: "Deposit paid",
  in_progress: "In progress",
  substantially_complete: "Substantially complete",
  paid_in_full: "Paid in full",
  warranty: "Under warranty",
  closed: "Closed",
  canceled: "Canceled",
});

const CO_AWAITING = ["Sent", "Viewed", "Awaiting Signature", "Partially Signed"];
const ACTIVE_SIGNATURE = ["Ready", "Sent", "Viewed", "Awaiting Signature", "Partially Signed"];

function money(cents) {
  return `$${(Number(cents || 0) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function daysBetween(from, to) {
  if (!from) return 0;
  return Math.floor((new Date(to).getTime() - new Date(from).getTime()) / DAY_MS);
}

function byVersionDesc(contracts) {
  return [...(contracts || [])].sort((a, b) => Number(b.version || 0) - Number(a.version || 0));
}

/** The agreement the owner is working on: signed if any, else the current issued/draft one. */
function workingAgreement(contracts) {
  const list = byVersionDesc(contracts);
  return (
    list.find((c) => c.status === "Signed") ||
    list.find((c) => c.current && ["Generated", "Emailed", "Draft"].includes(c.status)) ||
    list.find((c) => ["Generated", "Emailed"].includes(c.status)) ||
    list.find((c) => c.current) ||
    list[0] ||
    null
  );
}

function liveInvoices(invoices) {
  return (invoices || []).filter((invoice) => !invoice.isArchived && invoice.status !== "Voided" && invoice.status !== "Superseded");
}

function isOverdue(invoice, now) {
  if (!countsTowardInvoiced(invoice)) return false;
  const balance = Number(invoice.invoiceTotalCents || 0) - paidOnInvoice(invoice);
  if (balance <= 0) return false;
  if (invoice.status === "Overdue") return true;
  const due = invoice.dates?.dueDate;
  return Boolean(due && new Date(due).getTime() < new Date(now).getTime());
}

/** The deposit row of a payment schedule, if the agreement lists one. */
function depositScheduleIndex(schedule) {
  return (schedule || []).findIndex((row) => /deposit|down ?payment|upon signing|at signing/i.test(`${row.label} ${row.dueCondition}`));
}

/**
 * The live billing claim for the deposit or one schedule row of THIS PROJECT.
 *
 * Claims are matched per project + kind + row, whatever agreement version
 * they were made against (review fix 2026-11-13): a revised and re-signed
 * agreement gets a new Contract _id, and keying on it let the v1 deposit be
 * billed a second time. `contractId` is kept in the signature for callers.
 */
function claimFor(project, _contractId, kind, scheduleIndex = null, invoicesById = new Map()) {
  return (project.billingClaims || []).find((claim) => {
    if (claim.kind !== kind) return false;
    if (kind === "milestone" && Number(claim.scheduleIndex) !== Number(scheduleIndex)) return false;
    if (!claim.invoiceId) return true;
    const invoice = invoicesById.get(String(claim.invoiceId));
    return Boolean(invoice && liveInvoices([invoice]).length);
  }) || null;
}

function normalizedLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function invoiceHasLine(invoice, test) {
  return (invoice.lineItems || []).some((line) => test(normalizedLabel(line.description)));
}

/** Invoices already accounted for by a milestone claim (they are not the deposit). */
function milestoneClaimInvoiceIds(project) {
  return new Set(
    (project.billingClaims || [])
      .filter((claim) => claim.kind === "milestone" && claim.invoiceId)
      .map((claim) => String(claim.invoiceId))
  );
}

/**
 * Is the deposit billed? A deposit claim made through "Create deposit
 * invoice", or - for projects billed by hand before this existed - a live
 * invoice of this project with a deposit line, or live invoices (other than
 * known milestone invoices) that already cover the deposit amount. Every
 * agreement version of the project counts: a re-signed agreement does not
 * reopen a deposit that was already invoiced.
 */
function depositBilled(project, agreement, invoices, invoicesById) {
  if (claimFor(project, agreement._id, "deposit", null, invoicesById)) return true;
  const deposit = Number(agreement.depositAmountCents || 0);
  const milestoneIds = milestoneClaimInvoiceIds(project);
  const candidates = liveInvoices(invoices).filter((invoice) => !milestoneIds.has(String(invoice._id)));
  if (candidates.some((invoice) => invoiceHasLine(invoice, (label) => /deposit|down ?payment/.test(label)))) return true;
  const billed = candidates.reduce((sum, invoice) => sum + Number(invoice.invoiceTotalCents || 0), 0);
  return deposit > 0 && billed >= deposit;
}

/**
 * Is one payment-schedule row billed? Its claim (any agreement version), or a
 * live invoice of this project carrying a line with the row's label - which
 * is exactly what "Bill milestone" writes, and what a hand-made invoice for
 * that row would say.
 */
function milestoneBilled(project, agreement, scheduleIndex, invoices, invoicesById) {
  if (claimFor(project, agreement._id, "milestone", scheduleIndex, invoicesById)) return true;
  const row = (agreement.paymentSchedule || [])[scheduleIndex];
  const label = normalizedLabel(row?.label);
  if (!label) return false;
  return liveInvoices(invoices).some((invoice) => invoiceHasLine(invoice, (line) => line === label));
}

/** The derived stage, from documents and closeout fields only. */
function buildDerivedStage({ project, contracts, financials, now = new Date() }) {
  const signed = byVersionDesc(contracts).find((c) => c.status === "Signed");
  const issued = byVersionDesc(contracts).find((c) => ["Generated", "Emailed"].includes(c.status) && c.current !== false);
  const valuation = financials?.valuation || {};
  const paid = Number(valuation.paidCents || 0);
  const executedValue = Number(valuation.executedValueCents || 0);

  let key = "lead";
  if (!signed && !issued && (contracts || []).length && (contracts || []).every((c) => c.status === "Canceled")) key = "canceled";
  else if (!signed && issued) key = "proposal_issued";
  else if (signed) {
    key = "signed";
    const deposit = Number(signed.depositAmountCents || 0);
    if (paid > 0 && paid >= deposit) key = "deposit_paid";
    const started = project.scheduledStart && new Date(project.scheduledStart).getTime() <= new Date(now).getTime();
    if (key === "deposit_paid" && started) key = "in_progress";
    if (project.substantialCompletionAt) {
      key = "substantially_complete";
      if (executedValue > 0 && paid >= executedValue) {
        // Paid in full after completion: the warranty clock decides what follows.
        const ends = project.warrantyEndsAt ? new Date(project.warrantyEndsAt).getTime() : null;
        key = !ends ? "paid_in_full" : ends > new Date(now).getTime() ? "warranty" : "closed";
      }
    }
  }
  return { key, label: STAGES[key] };
}

function step(key, label, detail, severity, action) {
  return { key, label, detail, severity, action };
}

/** The address a send for this document goes to (the route's default recipient). */
function recipientOf(doc) {
  return String(doc?.customerSnapshot?.email || "").trim().toLowerCase() || null;
}

/**
 * Next steps, most urgent first. Each comes from a record, says why, and
 * carries the action that resolves it.
 */
function buildNextSteps({ project, contracts, changeOrders, invoices, signatures, financials, now = new Date() }) {
  const steps = [];
  const projectId = String(project._id);
  const projectHref = `/admin/projects/${projectId}`;
  const invoicesById = new Map((invoices || []).map((invoice) => [String(invoice._id), invoice]));
  const agreement = workingAgreement(contracts);
  const sigsFor = (documentType, documentId) =>
    (signatures || [])
      .filter((s) => s.documentType === documentType && String(s.documentId) === String(documentId))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

  // 1. Agreement.
  if (!agreement || agreement.status === "Canceled") {
    if (!(contracts || []).some((c) => c.status === "Signed")) {
      steps.push(
        step("create_agreement", "Prepare the agreement", "No agreement has been issued for this project yet.", "attention", {
          type: "navigate",
          href: `${projectHref}?tab=agreement`,
        })
      );
    }
  } else if (agreement.status === "Draft") {
    steps.push(
      step("generate_agreement", "Finish and generate the agreement", `Agreement #${agreement.contractNumber} v${agreement.version} is still a draft.`, "attention", {
        type: "navigate",
        href: `${projectHref}?tab=agreement`,
      })
    );
  } else if (["Generated", "Emailed"].includes(agreement.status)) {
    const latest = sigsFor("CONTRACT", agreement._id)[0];
    const live = latest && ACTIVE_SIGNATURE.includes(latest.status) && latest.signingToken?.state === "active";
    if (live) {
      const since = latest.sentAt || latest.createdAt;
      const days = daysBetween(since, now);
      steps.push(
        step(
          "agreement_awaiting_signature",
          days >= AWAITING_SIGNATURE_NUDGE_DAYS ? "Agreement not signed yet: resend" : "Agreement awaiting signature",
          `Sent ${days} day${days === 1 ? "" : "s"} ago${latest.signingToken?.openedAt ? ", opened by the customer" : ", not opened yet"}.`,
          days >= AWAITING_SIGNATURE_NUDGE_DAYS ? "attention" : "info",
          latest.signingMode === "REMOTE"
            ? { type: "endpoint", method: "POST", endpoint: `/api/admin/signatures/native/${latest._id}/resend`, recipientEmail: recipientOf(agreement) }
            : { type: "navigate", href: `${projectHref}?tab=agreement` }
        )
      );
    } else if (latest?.status === "Declined") {
      steps.push(
        step("signature_declined", "Customer declined the agreement", latest.declineReason ? `Reason: ${latest.declineReason}` : "No reason was given. Call the customer.", "problem", {
          type: "navigate",
          href: `${projectHref}?tab=agreement`,
        })
      );
    } else if (latest?.status === "Expired") {
      steps.push(
        step("signature_expired", "Signing link expired", "The customer did not sign before the link ran out. Send a new request.", "problem", {
          type: "endpoint",
          method: "POST",
          endpoint: "/api/admin/signatures/native/send",
          body: { documentType: "CONTRACT", documentId: String(agreement._id), mode: "REMOTE" },
          recipientEmail: recipientOf(agreement),
        })
      );
    } else {
      steps.push(
        step("send_agreement", "Send the agreement for signature", `Agreement #${agreement.contractNumber} is generated but no signature request is open.`, "attention", {
          type: "endpoint",
          method: "POST",
          endpoint: "/api/admin/signatures/native/send",
          body: { documentType: "CONTRACT", documentId: String(agreement._id), mode: "REMOTE" },
          recipientEmail: recipientOf(agreement),
        })
      );
    }
  }

  const signed = agreement?.status === "Signed" ? agreement : null;

  // 2. Deposit and milestones, from the signed agreement's own terms.
  if (signed) {
    const deposit = Number(signed.depositAmountCents || 0);
    const hasDeposit = deposit > 0;
    const depositDone = !hasDeposit || depositBilled(project, signed, invoices, invoicesById);
    if (hasDeposit && !depositDone) {
      steps.push(
        step("deposit_not_invoiced", `Create the deposit invoice for ${money(deposit)}`, "The agreement is signed and no deposit invoice exists yet.", "attention", {
          type: "endpoint",
          method: "POST",
          endpoint: `/api/admin/projects/${projectId}/invoices/from-schedule`,
          body: { kind: "deposit" },
          amountCents: deposit,
          recipientEmail: recipientOf(signed),
        })
      );
    }
    if (depositDone) {
      const schedule = signed.paymentSchedule || [];
      const depositIndex = depositScheduleIndex(schedule);
      const nextIndex = schedule.findIndex(
        (row, index) => index !== depositIndex && Number(row.amountCents || 0) > 0 && !milestoneBilled(project, signed, index, invoices, invoicesById)
      );
      if (nextIndex >= 0) {
        const row = schedule[nextIndex];
        steps.push(
          step("bill_next_milestone", `Bill next milestone: ${row.label} (${money(row.amountCents)})`, `Due: ${row.dueCondition}`, "info", {
            type: "endpoint",
            method: "POST",
            endpoint: `/api/admin/projects/${projectId}/invoices/from-schedule`,
            body: { kind: "milestone", scheduleIndex: nextIndex },
            amountCents: Number(row.amountCents || 0),
            scheduleIndex: nextIndex,
            recipientEmail: recipientOf(signed),
          })
        );
      }
    }
    if (!project.scheduledStart) {
      steps.push(
        step("schedule_work", "Schedule the work", "The agreement is signed but no start date or crew is set.", "info", {
          type: "navigate",
          href: `${projectHref}?tab=schedule`,
        })
      );
    }
  }

  // 3. Change orders.
  for (const co of changeOrders || []) {
    if (co.status === "Ready to Send") {
      steps.push(
        step("change_order_not_sent", `Send change order ${co.changeOrderNumber}`, co.title || "Generated and not sent yet.", "attention", {
          type: "endpoint",
          method: "POST",
          endpoint: "/api/admin/signatures/native/send",
          body: { documentType: "CHANGE_ORDER", documentId: String(co._id), mode: "REMOTE" },
          amountCents: Number(co.netAdjustmentCents || 0),
          recipientEmail: recipientOf(co),
        })
      );
      continue;
    }
    const latest = sigsFor("CHANGE_ORDER", co._id)[0];
    const live = latest && ACTIVE_SIGNATURE.includes(latest.status) && latest.signingToken?.state === "active";
    if (CO_AWAITING.includes(co.status) || live) {
      const days = daysBetween(latest?.sentAt || co.sentAt || co.updatedAt, now);
      steps.push(
        step(
          "change_order_awaiting_signature",
          `Change order ${co.changeOrderNumber} awaiting signature`,
          `${co.title || "Change order"} - sent ${days} day${days === 1 ? "" : "s"} ago.`,
          days >= AWAITING_SIGNATURE_NUDGE_DAYS ? "attention" : "info",
          live && latest.signingMode === "REMOTE"
            ? { type: "endpoint", method: "POST", endpoint: `/api/admin/signatures/native/${latest._id}/resend`, recipientEmail: recipientOf(co) }
            : { type: "navigate", href: `${projectHref}?tab=change-orders` }
        )
      );
    } else if (latest?.status === "Declined" && co.status !== "Voided" && co.status !== "Executed") {
      steps.push(
        step("change_order_declined", `Customer declined change order ${co.changeOrderNumber}`, latest.declineReason || "No reason was given.", "problem", {
          type: "navigate",
          href: `${projectHref}?tab=change-orders`,
        })
      );
    }
  }

  // 4. Invoices.
  for (const invoice of invoices || []) {
    if (isOverdue(invoice, now)) {
      const balance = Number(invoice.invoiceTotalCents || 0) - paidOnInvoice(invoice);
      steps.push(
        step("invoice_overdue", `Invoice #${invoice.invoiceNumber} is overdue`, `${money(balance)} outstanding, due ${new Date(invoice.dates.dueDate).toISOString().slice(0, 10)}.`, "problem", {
          type: "navigate",
          href: `${projectHref}?tab=invoices&invoice=${invoice._id}`,
          invoiceId: String(invoice._id),
          amountCents: balance,
          recipientEmail: recipientOf(invoice),
        })
      );
    }
  }

  // 5. Closeout.
  if (project.substantialCompletionAt) {
    const uninvoiced = Number(financials?.valuation?.uninvoicedExecutedCents || 0);
    if (uninvoiced > 0) {
      steps.push(
        step("final_invoice", `Send the final invoice (${money(uninvoiced)} not billed)`, "The work is substantially complete and part of the agreed value is not invoiced.", "attention", {
          type: "navigate",
          href: `${projectHref}?tab=invoices`,
          amountCents: uninvoiced,
        })
      );
    }
  }
  const open = (project.punchList || []).filter((item) => !item.done);
  if (open.length) {
    steps.push(
      step("punch_list_open", `${open.length} punch list item${open.length === 1 ? "" : "s"} open`, open.slice(0, 3).map((item) => item.text).join("; "), project.substantialCompletionAt ? "attention" : "info", {
        type: "navigate",
        href: `${projectHref}?tab=closeout`,
      })
    );
  }

  const rank = { problem: 0, attention: 1, info: 2 };
  return steps.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

function serializeSignatureState(signature) {
  if (!signature) return null;
  return {
    id: String(signature._id),
    status: signature.status,
    mode: signature.signingMode,
    sentAt: signature.sentAt || null,
    openedAt: signature.signingToken?.openedAt || null,
    expiresAt: signature.signingToken?.expiresAt || null,
    completedAt: signature.completedAt || null,
    declinedAt: signature.declinedAt || null,
    live: ACTIVE_SIGNATURE.includes(signature.status) && signature.signingToken?.state === "active",
  };
}

function documentsSummary({ contracts, changeOrders, invoices, signatures, now }) {
  const latestSig = (type, id) =>
    (signatures || [])
      .filter((s) => s.documentType === type && String(s.documentId) === String(id))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
  return {
    agreements: byVersionDesc(contracts).map((c) => ({
      id: String(c._id),
      contractNumber: c.contractNumber,
      version: Number(c.version || 1),
      status: c.status,
      current: c.current !== false,
      priceCents: Number(c.adjustedContractPriceCents ?? c.totalPriceCents ?? 0),
      depositAmountCents: Number(c.depositAmountCents || 0),
      recipientEmail: recipientOf(c),
      signature: serializeSignatureState(latestSig("CONTRACT", c._id)),
    })),
    changeOrders: (changeOrders || []).map((co) => ({
      id: String(co._id),
      changeOrderNumber: co.changeOrderNumber,
      title: co.title || "",
      status: co.status,
      netAdjustmentCents: Number(co.netAdjustmentCents || 0),
      recipientEmail: recipientOf(co),
      signature: serializeSignatureState(latestSig("CHANGE_ORDER", co._id)),
    })),
    invoices: (invoices || []).map((invoice) => ({
      id: String(invoice._id),
      invoiceNumber: invoice.invoiceNumber,
      status: invoice.status,
      totalCents: Number(invoice.invoiceTotalCents || 0),
      paidCents: paidOnInvoice(invoice),
      balanceCents: Math.max(Number(invoice.invoiceTotalCents || 0) - paidOnInvoice(invoice), 0),
      dueDate: invoice.dates?.dueDate || null,
      overdue: isOverdue(invoice, now),
      recipientEmail: recipientOf(invoice),
    })),
  };
}

const PROJECT_SELECT =
  "projectNumber status customerName email phone address customerId projectType notes isDeleted deletedAt leadRef qualification linkedBookingIds siteVisitBookingId scheduledStart scheduledEnd assignedFixterIds substantialCompletionAt warrantyEndsAt warrantyTermsVersion punchList statusHistory billingClaims createdAt updatedAt";

/** Fields the stage and next-step rules read. Shared by the overview and the list. */
const CONTRACT_SELECT =
  "projectId contractNumber version current status adjustedContractPriceCents totalPriceCents depositAmountCents paymentSchedule customerSnapshot.email createdAt updatedAt";
const CHANGE_ORDER_SELECT = "changeOrderNumber title status netAdjustmentCents sentAt updatedAt contractId sequence customerSnapshot.email";
const INVOICE_SELECT = "projectId invoiceNumber status invoiceTotalCents payments dates sentAt contractId isArchived customerSnapshot.email lineItems.description createdAt";
const SIGNATURE_SELECT =
  "projectId documentType documentId status signingMode sentAt createdAt completedAt declinedAt declineReason signingToken.state signingToken.openedAt signingToken.expiresAt";
/** Project fields buildNextSteps reads, for list rows. */
const NEXT_STEP_PROJECT_SELECT = "scheduledStart substantialCompletionAt warrantyEndsAt punchList billingClaims";

async function loadProjectRecords(projectId) {
  const project = await Project.findById(projectId).select(PROJECT_SELECT).lean();
  if (!project) return null;
  const contracts = await Contract.find({ projectId }).select(CONTRACT_SELECT).lean();
  const contractIds = contracts.map((c) => c._id);
  const [changeOrders, invoices, signatures] = await Promise.all([
    ChangeOrder.find({ contractId: { $in: contractIds } }).select(CHANGE_ORDER_SELECT).sort({ sequence: 1 }).lean(),
    Invoice.find({ projectId, isArchived: { $ne: true } }).select(INVOICE_SELECT).sort({ createdAt: 1 }).lean(),
    ESignature.find({ projectId }).select(SIGNATURE_SELECT).lean(),
  ]);
  return { project, contracts, changeOrders, invoices, signatures };
}

function groupBy(rows, keyOf) {
  const map = new Map();
  for (const row of rows) {
    const key = String(keyOf(row));
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

/**
 * The top next step for many projects at once, for list rows.
 *
 * Runs the SAME buildNextSteps as the overview over the same records, loaded
 * in four batched queries (agreements, change orders, invoices, signatures)
 * instead of one overview per row. `projects` must carry the fields in
 * NEXT_STEP_PROJECT_SELECT; `financialsById` maps project id to its
 * getProjectFinancialSummary result (the list already computes it).
 *
 * Returns Map(projectId -> {key, label, severity} | null).
 */
async function topNextStepsForProjects(projects, { financialsById = new Map(), now = new Date() } = {}) {
  const result = new Map();
  if (!projects?.length) return result;
  const projectIds = projects.map((p) => p._id);
  const contracts = await Contract.find({ projectId: { $in: projectIds } }).select(CONTRACT_SELECT).lean();
  const [changeOrders, invoices, signatures] = await Promise.all([
    contracts.length
      ? ChangeOrder.find({ contractId: { $in: contracts.map((c) => c._id) } }).select(CHANGE_ORDER_SELECT).sort({ sequence: 1 }).lean()
      : [],
    Invoice.find({ projectId: { $in: projectIds }, isArchived: { $ne: true } }).select(INVOICE_SELECT).sort({ createdAt: 1 }).lean(),
    ESignature.find({ projectId: { $in: projectIds } }).select(SIGNATURE_SELECT).lean(),
  ]);
  const contractsByProject = groupBy(contracts, (c) => c.projectId);
  const projectOfContract = new Map(contracts.map((c) => [String(c._id), String(c.projectId)]));
  const changeOrdersByProject = groupBy(changeOrders, (co) => projectOfContract.get(String(co.contractId)));
  const invoicesByProject = groupBy(invoices, (invoice) => invoice.projectId);
  const signaturesByProject = groupBy(signatures, (signature) => signature.projectId);

  for (const project of projects) {
    const id = String(project._id);
    const steps = buildNextSteps({
      project,
      contracts: contractsByProject.get(id) || [],
      changeOrders: changeOrdersByProject.get(id) || [],
      invoices: invoicesByProject.get(id) || [],
      signatures: signaturesByProject.get(id) || [],
      financials: financialsById.get(id) || null,
      now,
    });
    const top = steps[0];
    result.set(id, top ? { key: top.key, label: top.label, severity: top.severity } : null);
  }
  return result;
}

/** The project overview the redesigned Admin opens on. */
async function loadProjectOverview(projectId, { now = new Date() } = {}) {
  const records = await loadProjectRecords(projectId);
  if (!records) return null;
  const { project, contracts, changeOrders, invoices, signatures } = records;
  const financials = await getProjectFinancialSummary(projectId);

  const bookingIds = [...new Set([...(project.linkedBookingIds || []), project.siteVisitBookingId].filter(Boolean).map(String))];
  const bookings = bookingIds.length
    ? await Booking.find({ _id: { $in: bookingIds } })
        .select("bookingNumber date status service assignedTo selectedTask")
        .lean()
    : [];

  let lead = null;
  if (project.leadRef?.id) {
    const slug = project.leadRef.model === "EstimateLead" ? "estimate" : "request";
    lead = {
      model: slug,
      id: String(project.leadRef.id),
      href: `/admin/leads/${slug}-${project.leadRef.id}`,
    };
  }

  const derivedStage = buildDerivedStage({ project, contracts, financials, now });
  const nextSteps = buildNextSteps({ project, contracts, changeOrders, invoices, signatures, financials, now });
  return {
    project: {
      id: String(project._id),
      projectNumber: project.projectNumber,
      customerName: project.customerName,
      email: project.email,
      phone: project.phone,
      address: project.address,
      customerId: project.customerId ? String(project.customerId) : null,
      projectType: project.projectType,
      notes: project.notes || "",
      isDeleted: project.isDeleted === true,
      qualification: project.qualification || null,
      scheduledStart: project.scheduledStart || null,
      scheduledEnd: project.scheduledEnd || null,
      assignedFixterIds: (project.assignedFixterIds || []).map(String),
      substantialCompletionAt: project.substantialCompletionAt || null,
      warrantyEndsAt: project.warrantyEndsAt || null,
      punchList: (project.punchList || []).map((item) => ({
        id: String(item._id),
        text: item.text,
        done: Boolean(item.done),
        doneAt: item.doneAt || null,
      })),
      statusHistory: (project.statusHistory || []).map((entry) => ({
        from: entry.from,
        to: entry.to,
        at: entry.at,
        actorName: entry.actorName,
        reason: entry.reason,
        source: entry.source,
      })),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    manualStatus: project.status,
    derivedStage,
    financials: {
      executedValueCents: financials.valuation.executedValueCents,
      proposedValueCents: financials.valuation.proposedValueCents,
      invoicedCents: financials.valuation.invoicedCents,
      paidCents: financials.valuation.paidCents,
      outstandingCents: financials.valuation.outstandingCents,
      uninvoicedExecutedCents: financials.valuation.uninvoicedExecutedCents,
      agreementSigned: financials.valuation.agreementSigned,
      pendingChangeOrderCents: financials.totals.pendingChangeOrderCents,
    },
    nextSteps,
    documents: documentsSummary({ contracts, changeOrders, invoices, signatures, now }),
    linkedBookings: bookings.map((booking) => ({
      id: String(booking._id),
      bookingNumber: booking.bookingNumber,
      date: booking.date,
      status: booking.status,
      service: booking.service,
      isSiteVisit: String(booking._id) === String(project.siteVisitBookingId || ""),
      href: `/admin/jobs/${booking._id}`,
    })),
    lead,
    allowedActions: {
      edit: !project.isDeleted,
      markSubstantiallyComplete: !project.isDeleted && !project.substantialCompletionAt && derivedStage.key !== "lead" && derivedStage.key !== "proposal_issued" && derivedStage.key !== "canceled",
      createDepositInvoice: nextSteps.some((s) => s.key === "deposit_not_invoiced"),
      linkBooking: !project.isDeleted,
      editPunchList: !project.isDeleted,
    },
  };
}

module.exports = {
  STAGES,
  AWAITING_SIGNATURE_NUDGE_DAYS,
  buildDerivedStage,
  buildNextSteps,
  depositScheduleIndex,
  depositBilled,
  milestoneBilled,
  isOverdue,
  workingAgreement,
  loadProjectRecords,
  loadProjectOverview,
  topNextStepsForProjects,
  NEXT_STEP_PROJECT_SELECT,
};
