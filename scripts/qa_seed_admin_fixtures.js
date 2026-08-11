/**
 * TEST-ONLY deterministic fixtures for authenticated Admin visual QA.
 *
 * NEVER RUN THIS AGAINST A REAL DATABASE. It refuses to connect to anything
 * that is not an in-memory or explicitly-named test database, because seeding
 * fabricated agreements into production would be unrecoverable.
 *
 * Everything is deterministic: fixed ids, fixed numbers, fixed amounts, fixed
 * dates. Layout QA has to be able to re-run and compare, so nothing here may
 * vary between runs.
 *
 * Storage keys are realistic but no bytes are written. The Admin decides which
 * actions to show from key presence alone, so this produces the same action
 * states production would - downloads are simply not exercised in this pass.
 */

const mongoose = require("mongoose");

const Contract = require("../models/Contract");
const ChangeOrder = require("../models/ChangeOrder");
const ESignature = require("../models/ESignature");
const Project = require("../models/Project");
const User = require("../models/User");

/* ------------------------------------------------------------------ */
/* Hostile layout content                                              */
/* ------------------------------------------------------------------ */

/** 43 characters, hyphenated - the classic wrap breaker. */
const LONG_NAME = "Konstantinos Papadopoulos-Wetherington III";
/** 95 characters of real Suffolk County address shape. */
const LONG_ADDRESS =
  "1247 Old Country Road, Building C, Apartment 14B, Hauppauge, Suffolk County, New York 11788-4021";
const LONG_CO_DESCRIPTION =
  "Remove and replace all existing galvanized supply piping throughout the first floor including " +
  "the kitchen, both bathrooms and the utility room, relocate the main shutoff to the utility " +
  "closet, install new quarter-turn stops at every fixture, and patch, skim and paint all opened " +
  "wall and ceiling surfaces to match the existing finish.";

/** Deterministic ids so QA can navigate straight to a known fixture. */
const ID = {
  admin: new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaa01"),
  project: new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaa02"),
  agreementDraft: new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaa03"),
  agreementAwaiting: new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaa04"),
  agreementSigned: new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaa05"),
  agreementManual: new mongoose.Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaa06"),
};

const ADMIN_EMAIL = "qa-admin@profixter.test";

const DATE = new Date("2026-08-01T12:00:00Z");

/** A large value, to check money formatting and column widths. */
const BIG_AMOUNT_CENTS = 18750000; // $187,500.00

const key = (...parts) => `private/admin/qa/${parts.join("/")}.pdf`;

/* ------------------------------------------------------------------ */

function assertTestDatabase(uri) {
  const value = String(uri || "");
  const isMemory = /127\.0\.0\.1|localhost/.test(value);
  const isNamedTest = /test|qa/i.test(value);
  if (!isMemory && !isNamedTest) {
    throw new Error(
      `Refusing to seed QA fixtures into ${value}. This script is test-only and will not run ` +
        "against a remote or unnamed database."
    );
  }
}

function contractBase(overrides) {
  return {
    projectId: ID.project,
    version: 1,
    current: true,
    customerSnapshot: { fullName: LONG_NAME, email: "qa-customer@profixter.test", phone: "631-555-0142" },
    propertySnapshot: { address: LONG_ADDRESS, projectNumber: "P-QA-0001" },
    workType: "Bathroom",
    projectDescription: "Full bathroom renovation with plumbing replacement.",
    scopeText: "Demolition, rough plumbing, tile, fixtures, paint.",
    originalContractPriceCents: BIG_AMOUNT_CENTS,
    totalPriceCents: BIG_AMOUNT_CENTS,
    adjustedContractPriceCents: BIG_AMOUNT_CENTS,
    depositAmountCents: 5000000,
    remainingBalanceCents: BIG_AMOUNT_CENTS - 5000000,
    paymentSchedule: [],
    dates: { contractDate: DATE },
    optionalDetails: {},
    createdBy: ID.admin,
    ...overrides,
  };
}

async function seedAdminFixtures() {
  assertTestDatabase(mongoose.connection?.client?.s?.url || process.env.MONGO_URI);

  // Deterministic: wipe anything a previous run left behind.
  await Promise.all([
    User.deleteMany({ email: ADMIN_EMAIL }),
    Project.deleteMany({ _id: ID.project }),
    Contract.deleteMany({ projectId: ID.project }),
    ChangeOrder.deleteMany({ projectId: ID.project }),
    ESignature.deleteMany({ projectId: ID.project }),
  ]);

  /* --- admin identity --- */
  const admin = await User.create({
    _id: ID.admin,
    userId: "QA-ADMIN-0001",
    name: "QA Admin",
    email: ADMIN_EMAIL,
    password: "not-used-jwt-is-minted-directly",
    role: "admin",
    isActive: true,
  });

  /* --- project --- */
  const project = await Project.create({
    _id: ID.project,
    projectNumber: "P-QA-0001",
    status: "In Progress",
    customerName: LONG_NAME,
    email: "qa-customer@profixter.test",
    phone: "631-555-0142",
    address: LONG_ADDRESS,
    customerSnapshot: { fullName: LONG_NAME, email: "qa-customer@profixter.test", phone: "631-555-0142" },
    propertySnapshot: { formattedAddress: LONG_ADDRESS, addressLine1: LONG_ADDRESS },
    projectType: "Bathroom",
    estimateAmount: BIG_AMOUNT_CENTS / 100,
    depositAmount: 50000,
    balanceDue: (BIG_AMOUNT_CENTS - 5000000) / 100,
    notes: "QA fixture project. Test data only.",
  });

  /* --- Agreements, one per state --- */
  const agreements = {};

  agreements.draft = await Contract.create(
    contractBase({ _id: ID.agreementDraft, contractNumber: "QA0001", status: "Generated", current: false,
      generatedPdf: { key: key("QA0001", "generated"), fileName: "QA0001.pdf", size: 12000, generatedAt: DATE } })
  );

  agreements.awaiting = await Contract.create(
    contractBase({ _id: ID.agreementAwaiting, contractNumber: "QA0002", status: "Emailed", current: false,
      generatedPdf: { key: key("QA0002", "generated"), fileName: "QA0002.pdf", size: 12000, generatedAt: DATE } })
  );

  agreements.signed = await Contract.create(
    contractBase({ _id: ID.agreementSigned, contractNumber: "QA0003", status: "Signed", current: false,
      generatedPdf: { key: key("QA0003", "generated"), fileName: "QA0003.pdf", size: 12000, generatedAt: DATE },
      signedPdf: { key: key("QA0003", "signed"), fileName: "QA0003-signed.pdf", size: 13000, uploadedAt: DATE } })
  );

  agreements.manual = await Contract.create(
    contractBase({ _id: ID.agreementManual, contractNumber: "QA0004", status: "Signed", current: true,
      generatedPdf: { key: key("QA0004", "generated"), fileName: "QA0004.pdf", size: 12000, generatedAt: DATE },
      signedPdf: { key: key("QA0004", "signed"), fileName: "QA0004-scan.pdf", size: 20000, uploadedAt: DATE } })
  );

  /* --- Signatures, one per provider/mode --- */
  const signerBase = { role: "CUSTOMER", name: LONG_NAME, email: "qa-customer@profixter.test", order: 1 };

  const signatures = {};

  // Native remote, awaiting signature.
  signatures.remotePending = await ESignature.create({
    projectId: ID.project, documentType: "CONTRACT", documentId: ID.agreementAwaiting,
    documentNumber: "QA0002", provider: "native", signingMode: "REMOTE", status: "Sent",
    signers: [{ ...signerBase, status: "Pending" }],
    sentAt: DATE,
    frozenDocument: { key: key("QA0002", "frozen"), fileName: "QA0002-frozen.pdf", size: 12000, sha256: "a".repeat(64), documentVersion: 1, frozenAt: DATE },
    signingToken: { hash: "b".repeat(64), state: "active", issuedAt: DATE, expiresAt: new Date("2026-12-01T00:00:00Z"), sendCount: 1, lastSentAt: DATE },
  });

  // Native remote, completed.
  signatures.remoteSigned = await ESignature.create({
    projectId: ID.project, documentType: "CONTRACT", documentId: ID.agreementSigned,
    documentNumber: "QA0003", provider: "native", signingMode: "REMOTE", status: "Completed",
    signers: [{ ...signerBase, status: "Signed", viewedAt: new Date("2026-08-02T14:41:00Z"), signedAt: new Date("2026-08-02T14:46:00Z") }],
    sentAt: new Date("2026-08-02T14:34:00Z"), completedAt: new Date("2026-08-02T14:46:00Z"),
    consent: { disclosureVersion: "PIH-ESIGN-DISCLOSURE-2026-001", acceptedAt: new Date("2026-08-02T14:45:00Z") },
    frozenDocument: { key: key("QA0003", "frozen"), fileName: "QA0003-frozen.pdf", size: 12000, sha256: "c".repeat(64), documentVersion: 1, frozenAt: DATE },
    executedPdf: { key: key("QA0003", "executed"), fileName: "QA0003-executed.pdf", size: 13000, storedAt: DATE },
    certificatePdf: { key: key("QA0003", "certificate"), fileName: "QA0003-certificate.pdf", size: 4000, storedAt: DATE },
    executedSha256: "d".repeat(64),
    signingToken: { hash: "e".repeat(64), state: "completed", issuedAt: DATE },
  });

  // Native in person, completed.
  signatures.inPerson = await ESignature.create({
    projectId: ID.project, documentType: "CONTRACT", documentId: ID.agreementDraft,
    documentNumber: "QA0001", provider: "native", signingMode: "IN_PERSON", status: "Completed",
    signers: [{ ...signerBase, status: "Signed", signedAt: new Date("2026-08-03T10:12:00Z") }],
    completedAt: new Date("2026-08-03T10:12:00Z"),
    inPersonSession: { initiatedBy: ID.admin, initiatedByEmail: ADMIN_EMAIL, initiatedAt: DATE },
    consent: { disclosureVersion: "PIH-ESIGN-DISCLOSURE-2026-001", acceptedAt: new Date("2026-08-03T10:11:00Z") },
    frozenDocument: { key: key("QA0001", "frozen"), fileName: "QA0001-frozen.pdf", size: 12000, sha256: "f".repeat(64), documentVersion: 1, frozenAt: DATE },
    executedPdf: { key: key("QA0001", "executed"), fileName: "QA0001-executed.pdf", size: 13000, storedAt: DATE },
    certificatePdf: { key: key("QA0001", "certificate"), fileName: "QA0001-certificate.pdf", size: 4000, storedAt: DATE },
    executedSha256: "1".repeat(64),
    signingToken: { hash: "2".repeat(64), state: "completed", issuedAt: DATE },
  });

  // Manual upload - no token, no consent, no certificate. Must stay that way.
  signatures.manual = await ESignature.create({
    projectId: ID.project, documentType: "CONTRACT", documentId: ID.agreementManual,
    documentNumber: "QA0004", provider: "native", signingMode: "MANUAL_UPLOAD", status: "Completed",
    signers: [{ ...signerBase, status: "Signed" }],
    completedAt: new Date("2026-08-04T09:00:00Z"),
    executedPdf: { key: key("QA0004", "manual"), fileName: "QA0004-scan.pdf", size: 20000, storedAt: DATE },
    executedSha256: "3".repeat(64),
  });

  // Historical Adobe record - must remain readable after the cutover.
  signatures.adobe = await ESignature.create({
    projectId: ID.project, documentType: "CONTRACT", documentId: ID.agreementSigned,
    documentNumber: "QA0003", provider: "adobe_sign", status: "Completed",
    providerAgreementId: "CBJCHBCAABAA-qa-historical",
    signers: [{ ...signerBase, status: "Signed", signedAt: new Date("2026-07-01T09:00:00Z") }],
    completedAt: new Date("2026-07-01T09:00:00Z"),
    executedPdf: { key: key("QA0003", "adobe-executed"), fileName: "adobe-executed.pdf", size: 15000, storedAt: DATE },
  });

  /* --- Change Orders, one per variant --- */
  const coBase = (n, overrides) => ({
    changeOrderNumber: `CO-QA0003-0${n}`,
    sequence: n,
    projectId: ID.project,
    contractId: ID.agreementSigned,
    title: "Change order fixture",
    customerSnapshot: { fullName: LONG_NAME, email: "qa-customer@profixter.test" },
    propertySnapshot: { address: LONG_ADDRESS, projectNumber: "P-QA-0001" },
    contractSnapshot: { contractNumber: "QA0003", contractDate: DATE, originalContractAmountCents: BIG_AMOUNT_CENTS },
    contractAmountBeforeChangeCents: BIG_AMOUNT_CENTS,
    generatedPdf: { key: key(`CO0${n}`, "generated"), fileName: `CO0${n}.pdf`, size: 9000, generatedAt: DATE },
    createdBy: ID.admin,
    ...overrides,
  });

  const changeOrders = {};

  // Executed add: this one moves the current agreement value.
  changeOrders.add = await ChangeOrder.create(
    coBase(1, { status: "Executed", title: "Additional electrical work",
      lines: [{ description: "Add six recessed fixtures and a dimmer circuit", direction: "add", amountCents: 150000 }],
      executedAt: DATE,
      executedPdf: { key: key("CO01", "executed"), fileName: "CO01-executed.pdf", size: 9500, uploadedAt: DATE, source: "native_esign" } })
  );

  // Executed deduct.
  changeOrders.deduct = await ChangeOrder.create(
    coBase(2, { status: "Executed", title: "Remove decorative trim package",
      lines: [{ description: "Remove crown moulding from scope", direction: "deduct", amountCents: 45000 }],
      executedAt: DATE,
      executedPdf: { key: key("CO02", "executed"), fileName: "CO02-executed.pdf", size: 9500, uploadedAt: DATE, source: "native_esign" } })
  );

  // No cost.
  changeOrders.noCost = await ChangeOrder.create(
    coBase(3, { status: "Executed", title: "Fixture substitution at no cost",
      lines: [{ description: "Substitute equivalent faucet model", direction: "none", amountCents: 0 }],
      executedAt: DATE })
  );

  // Pending: must be projected only, never counted as current.
  changeOrders.pending = await ChangeOrder.create(
    coBase(4, { status: "Sent", title: "Heated floor addition",
      lines: [{ description: "Install electric radiant floor heat", direction: "add", amountCents: 400000 }],
      sentAt: DATE })
  );

  // Long description, to break wrapping if it can be broken.
  changeOrders.longDescription = await ChangeOrder.create(
    coBase(5, { status: "Ready to Send", title: "Whole-floor supply piping replacement",
      lines: [{ description: LONG_CO_DESCRIPTION, direction: "add", amountCents: 950000 }] })
  );

  // Signed change order with a native signature attached.
  changeOrders.signed = changeOrders.add;
  await ESignature.create({
    projectId: ID.project, documentType: "CHANGE_ORDER", documentId: changeOrders.add._id,
    documentNumber: changeOrders.add.changeOrderNumber, provider: "native", signingMode: "REMOTE",
    status: "Completed",
    signers: [{ ...signerBase, status: "Signed", signedAt: DATE }],
    completedAt: DATE,
    consent: { disclosureVersion: "PIH-ESIGN-DISCLOSURE-2026-001", acceptedAt: DATE },
    frozenDocument: { key: key("CO01", "frozen"), fileName: "CO01-frozen.pdf", size: 9000, sha256: "4".repeat(64), documentVersion: 1, frozenAt: DATE },
    executedPdf: { key: key("CO01", "executed"), fileName: "CO01-executed.pdf", size: 9500, storedAt: DATE },
    certificatePdf: { key: key("CO01", "certificate"), fileName: "CO01-certificate.pdf", size: 4000, storedAt: DATE },
    executedSha256: "5".repeat(64),
    signingToken: { hash: "6".repeat(64), state: "completed", issuedAt: DATE },
  });

  return {
    adminId: String(admin._id),
    adminEmail: ADMIN_EMAIL,
    projectId: String(project._id),
    projectNumber: project.projectNumber,
    agreements: Object.fromEntries(Object.entries(agreements).map(([k, v]) => [k, String(v._id)])),
    changeOrders: Object.fromEntries(Object.entries(changeOrders).map(([k, v]) => [k, String(v._id)])),
    signatures: Object.fromEntries(Object.entries(signatures).map(([k, v]) => [k, String(v._id)])),
    fixtures: { longName: LONG_NAME, longAddress: LONG_ADDRESS, longDescription: LONG_CO_DESCRIPTION },
  };
}

module.exports = { seedAdminFixtures, ID, ADMIN_EMAIL, LONG_NAME, LONG_ADDRESS, LONG_CO_DESCRIPTION };
