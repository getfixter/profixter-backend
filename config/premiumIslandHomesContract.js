const COMPANY_INFO = Object.freeze({
  legalName: "Premium Island Homes Inc.",
  addressLines: ["245 42nd Street", "Lindenhurst, NY 11757"],
  phone: "631-599-1363",
  email: "premiumislandconstruction@gmail.com",
  website: "profixter.com",
  homeImprovementLicense: "HI-71484",
  projectManager: "Taras Bandura",
});

const WORK_TYPES = Object.freeze([
  "Kitchen",
  "Bathroom",
  "Roofing",
  "Siding",
  "Flooring",
  "Sheetrock",
  "Home Remodeling",
  "Handyman",
  "Other",
]);

const CONTRACT_STATUSES = Object.freeze([
  "No Contract",
  "Draft",
  "Generated",
  "Emailed",
  "Signed",
  "Superseded",
  "Canceled",
]);

const CONTRACT_TERMS_VERSION = "PIH-NY-HI-2026-004";
const CANCELLATION_NOTICE_TERMS_VERSION = "PIH-NY-CANCEL-2026-001";

const NY_SOURCE_URLS = Object.freeze([
  "https://ag.ny.gov/home-improvement-fact-sheet",
  "https://dos.ny.gov/news/new-york-department-states-division-consumer-protection-announces-top-10-consumer-assistance",
]);

const ATTORNEY_REVIEW_NOTE =
  "Developer note: these contract terms are draft operating text and must be reviewed by a New York construction attorney before production use.";

const CANCELLATION_NOTICE_ATTORNEY_REVIEW_NOTE =
  "Developer note: Premium Island Homes should not disable this cancellation notice globally without review by a New York construction attorney.";

const CANCELLATION_NOTICE_CONFIG = Object.freeze({
  includeCancellationNotice: true,
  termsVersion: CANCELLATION_NOTICE_TERMS_VERSION,
  title: "Notice of Customer Cancellation Rights",
  body:
    "For New York residential home-improvement contracts, the customer may have statutory cancellation rights, including the right to cancel the agreement until midnight of the third business day after the agreement is signed, where applicable. Premium Island Homes Inc. must provide any legally required notice in the form and manner required by applicable law. This agreement does not waive any cancellation right that cannot be waived by law. No calendar cancellation deadline is generated in this agreement until the applicable legal rule has been verified and safely implemented.",
});

const CONTRACT_TERMS_SECTIONS = Object.freeze([
  {
    title: "Agreement Documents",
    body:
      "This agreement includes the customer and property information, project description, scope of work, final contract price, payment schedule, additional written project details, these terms, and the signature page. It is the entire agreement for the work described here. Any change must be in a written change order or written amendment.",
  },
  {
    title: "Scope, Exclusions, Materials, and Allowances",
    body:
      "Premium Island Homes Inc. will perform only the work described in this agreement and approved written change orders. Work, materials, repairs, finishes, fixtures, demolition, hauling, or services not listed are excluded unless added in writing. Materials, selections, and allowances are controlled by the project details when stated. The customer is responsible for approved selections and costs above any allowance unless otherwise stated.",
  },
  {
    title: "Customer-Supplied Items",
    body:
      "If the customer supplies materials, fixtures, appliances, or finishes, the customer is responsible for ordering accuracy, delivery timing, missing parts, defects, manufacturer warranty issues, and compatibility unless Premium Island Homes Inc. agrees otherwise in writing.",
  },
  {
    title: "Price, Payment, and Nonpayment",
    body:
      "The customer agrees to pay the final contract price according to the payment schedule. Discounts apply only to the original scope unless Premium Island Homes Inc. agrees otherwise in writing. Payments are due when the listed milestone or due condition occurs. Late or missed payments may delay scheduling, materials, inspections, completion, or final documents. Premium Island Homes Inc. may pause work or coordination if a required payment is not made when due.",
  },
  {
    title: "Change Orders",
    body:
      "Additional work, deleted work, material substitutions, price changes, and schedule changes must be documented and approved in writing before the changed work is performed. Verbal discussions do not change the agreement unless confirmed in writing.",
  },
  {
    title: "Concealed Conditions and Existing Defects",
    body:
      "Concealed, unknown, unsafe, code-related, structural, water, mold, rot, pest, electrical, plumbing, framing, substrate, hazardous, regulated, or other unforeseen conditions are not included unless specifically stated. Investigation, repair, remediation, testing, disposal, redesign, or additional work may require a written change order. Premium Island Homes Inc. is not responsible for pre-existing defects, improper prior work, hidden damage, code violations, material failures, or conditions outside the agreed scope except to the extent caused by Premium Island Homes Inc.",
  },
  {
    title: "Permits and Inspections",
    body:
      "Permit responsibility is stated in the project details. Municipal approvals, inspections, certificates, utility coordination, licensed trades, and agency timelines may affect scheduling and final payment timing. Work may be delayed until required approvals are satisfied.",
  },
  {
    title: "Schedule, Delays, and Material Availability",
    body:
      "Estimated start and completion dates are good-faith planning dates, not guarantees. Weather, supply issues, inspections, permits, utilities, government action, concealed conditions, change orders, customer delays, other contractors, discontinued products, delivery delays, supplier changes, and events outside reasonable control may affect the schedule. Substitutions must be discussed and documented when they affect price, appearance, performance, or schedule.",
  },
  {
    title: "Customer Responsibilities and Site Access",
    body:
      "The customer will provide safe access, working utilities where needed, parking or delivery access when available, clear work areas, secured pets, and timely decisions. The customer should remove fragile, valuable, or personal belongings from work areas before work begins. Customer delays, unavailable selections, denied access, unpaid balances, or work by others may change the schedule and may require documented coordination costs.",
  },
  {
    title: "Work Areas, Cleanup, Subcontractors, and Documentation",
    body:
      "Premium Island Homes Inc. will use reasonable care to protect work areas and adjacent areas. Construction can create dust, vibration, noise, and disruption. Routine cleanup and ordinary debris removal are included when stated or reasonably necessary for the agreed work. Premium Island Homes Inc. may use qualified subcontractors, vendors, suppliers, or specialty trades while remaining responsible for coordinating the agreed scope. Project photos or videos may be kept for records, quality control, scheduling, insurance, warranty, and portfolio purposes. Customer names and private identifying information will not be used publicly without permission.",
  },
  {
    title: "Substantial Completion, Punch List, and Final Payment",
    body:
      "Substantial completion occurs when the agreed work is usable for its intended purpose, even if minor punch-list items remain. Punch-list items should be documented during walkthrough or promptly after substantial completion. Premium Island Homes Inc. will make reasonable arrangements to complete valid punch-list work. Final payment is due according to the payment schedule. Minor punch-list items do not excuse final payment unless the parties agree in writing.",
  },
  {
    title: "Workmanship Warranty",
    body:
      "Premium Island Homes Inc. warrants its workmanship for one year from substantial completion unless a different written warranty is provided. The warranty covers correction of defective workmanship by Premium Island Homes Inc. It does not cover normal wear, maintenance, misuse, owner-supplied materials, manufacturer defects, structural movement, moisture from outside the agreed scope, acts of others, lack of maintenance, later alterations, or conditions not caused by Premium Island Homes Inc. Manufacturer warranties are provided by the manufacturer, and the customer is responsible for product registration unless otherwise stated.",
  },
  {
    title: "Termination, Notices, Signatures, and Governing Law",
    body:
      "Either party may seek to terminate or suspend the agreement for material breach after written notice and a reasonable opportunity to cure when appropriate. Written notices may be delivered by email, mail, hand delivery, or another written method the parties use for the project, unless law requires a different method. Electronic signatures, scanned signatures, and counterparts are intended to be enforceable. If one part is found unenforceable, the remaining parts remain in effect to the extent allowed by law. This agreement is governed by New York law.",
  },
]);

module.exports = {
  ATTORNEY_REVIEW_NOTE,
  CANCELLATION_NOTICE_ATTORNEY_REVIEW_NOTE,
  CANCELLATION_NOTICE_CONFIG,
  CANCELLATION_NOTICE_TERMS_VERSION,
  COMPANY_INFO,
  CONTRACT_STATUSES,
  CONTRACT_TERMS_SECTIONS,
  CONTRACT_TERMS_VERSION,
  NY_SOURCE_URLS,
  WORK_TYPES,
};
