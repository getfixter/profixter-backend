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

const CONTRACT_TERMS_VERSION = "PIH-NY-HI-2026-002";
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
    title: "Contract Documents and Entire Agreement",
    body:
      "This agreement consists of the customer and property information, project description, scope of work, price and payment schedule, additional written project details, these terms, and the signature page. It is the entire agreement between the customer and Premium Island Homes Inc. for the work described here. Any change must be documented in a written change order or written amendment.",
  },
  {
    title: "Scope of Work and Exclusions",
    body:
      "Premium Island Homes Inc. will perform only the work described in this agreement and approved written change orders. Work, materials, repairs, finishes, fixtures, demolition, hauling, or services not specifically listed are excluded unless added in writing.",
  },
  {
    title: "Materials and Allowances",
    body:
      "Materials, brands, model numbers, colors, selections, and allowances are controlled by the project details when stated. If an allowance is listed, the customer is responsible for approved selections or costs above that allowance unless otherwise stated in writing.",
  },
  {
    title: "Customer-Supplied Materials",
    body:
      "If the customer supplies materials, fixtures, appliances, or finishes, the customer is responsible for ordering accuracy, delivery timing, missing parts, defects, warranty issues, and compatibility unless Premium Island Homes Inc. agrees otherwise in writing.",
  },
  {
    title: "Price and Payment Schedule",
    body:
      "The customer agrees to pay the total contract price according to the payment schedule in this agreement. Progress payments should reasonably relate to work performed, materials purchased, mobilization, scheduling, or other project costs described in the agreement.",
  },
  {
    title: "Late or Missed Payments",
    body:
      "Payments are due when the listed milestone or due condition occurs. Late or missed payments may delay scheduling, material ordering, inspections, completion, or release of final documents.",
  },
  {
    title: "Right to Suspend Work for Nonpayment",
    body:
      "Premium Island Homes Inc. may pause work, deliveries, scheduling, or additional coordination if a required payment is not made when due. Work will resume after the account is brought current and the schedule can reasonably accommodate the project.",
  },
  {
    title: "Written Change Orders",
    body:
      "Additional work, deleted work, material substitutions, price changes, and schedule changes must be documented and approved in writing before the changed work is performed. Verbal discussions do not change the agreement unless confirmed in writing.",
  },
  {
    title: "Concealed and Unforeseen Conditions",
    body:
      "Concealed, unknown, unsafe, code-related, structural, water, mold, rot, pest, electrical, plumbing, framing, substrate, or other unforeseen conditions are not included unless specifically stated. Required investigation, repair, remediation, or redesign may require a written change order.",
  },
  {
    title: "Pre-Existing Defects and Damage",
    body:
      "Premium Island Homes Inc. is not responsible for pre-existing defects, improper prior work, hidden damage, code violations, material failures, or conditions outside the agreed scope except to the extent caused by Premium Island Homes Inc.",
  },
  {
    title: "Hazardous or Regulated Materials",
    body:
      "Hazardous or regulated materials, including asbestos, lead, mold, contaminated materials, or regulated waste, are excluded unless specifically included in writing. Discovery of these conditions may require work stoppage, testing, remediation, or a change order.",
  },
  {
    title: "Permits and Inspections",
    body:
      "Permit responsibility is stated in the project details. Required municipal approvals, inspections, certificates, utility coordination, and agency timelines may affect scheduling and final payment timing.",
  },
  {
    title: "Material Availability and Reasonable Substitutions",
    body:
      "Material availability, discontinued products, delivery delays, supplier changes, and manufacturer substitutions may affect the project. Reasonable substitutions must be discussed with the customer and documented when they affect price, appearance, performance, or schedule.",
  },
  {
    title: "Estimated Schedule and Delays",
    body:
      "Estimated start and completion dates are good-faith planning dates, not guarantees. Weather, supply chain issues, inspections, permit offices, utilities, government action, concealed conditions, change orders, customer delays, other contractors, and events outside reasonable control may affect the schedule.",
  },
  {
    title: "Customer Delays and Other Contractors",
    body:
      "Delays caused by customer decisions, unavailable selections, denied access, pets, personal property, unpaid balances, or work by other contractors may change the schedule and may require additional coordination costs if documented in writing.",
  },
  {
    title: "Property Access, Utilities, Pets, and Working Conditions",
    body:
      "The customer will provide safe and reasonable access, working utilities where needed, parking or delivery access when available, clear work areas, secured pets, and timely project decisions. The customer should remove fragile, valuable, or personal belongings from work areas before work begins.",
  },
  {
    title: "Protection of Belongings and Work Areas",
    body:
      "Premium Island Homes Inc. will use reasonable care to protect work areas and adjacent areas affected by the project. Construction can create dust, vibration, noise, and disruption, and the customer remains responsible for securing belongings outside the agreed work area.",
  },
  {
    title: "Subcontractors",
    body:
      "Premium Island Homes Inc. may use qualified subcontractors, vendors, suppliers, or specialty trades to perform portions of the work while remaining responsible for coordinating the agreed scope.",
  },
  {
    title: "Cleanup and Debris Removal",
    body:
      "Routine cleanup and debris removal are included when stated or reasonably necessary for the agreed work. Hazardous waste, excessive owner debris, or disposal outside the described project scope is excluded unless added in writing.",
  },
  {
    title: "Substantial Completion",
    body:
      "Substantial completion occurs when the agreed work is usable for its intended purpose, even if minor punch-list items remain. Substantial completion does not waive the customer's right to identify incomplete or deficient work.",
  },
  {
    title: "Punch-List Work",
    body:
      "Punch-list items should be documented during walkthrough or promptly after substantial completion. Premium Island Homes Inc. will make reasonable arrangements to complete valid punch-list work.",
  },
  {
    title: "Final Payment",
    body:
      "Final payment is due according to the payment schedule after substantial completion, final walkthrough, or the listed due condition. Minor punch-list items do not excuse final payment unless the parties agree in writing.",
  },
  {
    title: "Workmanship Warranty",
    body:
      "Premium Island Homes Inc. warrants its workmanship for one year from substantial completion unless a different written warranty is provided. The warranty covers correction of defective workmanship by Premium Island Homes Inc. and does not cover exclusions listed in this agreement.",
  },
  {
    title: "Manufacturer Warranties",
    body:
      "Manufacturer warranties for materials, fixtures, appliances, equipment, finishes, or products are provided by the manufacturer, not Premium Island Homes Inc. The customer is responsible for product registration unless otherwise stated.",
  },
  {
    title: "Warranty Exclusions",
    body:
      "Warranty coverage excludes normal wear, maintenance, misuse, abuse, owner-supplied materials, manufacturer defects, movement of existing structures, moisture from outside the agreed scope, acts of others, lack of maintenance, and conditions not caused by Premium Island Homes Inc.",
  },
  {
    title: "Damage or Alterations by Others",
    body:
      "Premium Island Homes Inc. is not responsible for damage, defects, or failures caused by the customer, occupants, guests, pets, other contractors, later alterations, misuse, lack of maintenance, or work performed by others.",
  },
  {
    title: "Photographs and Project Documentation",
    body:
      "Premium Island Homes Inc. may photograph, video, and document the project for records, quality control, scheduling, insurance, warranty, and portfolio purposes. Customer names and private identifying information will not be used publicly without permission.",
  },
  {
    title: "Termination or Suspension",
    body:
      "Either party may seek to terminate or suspend the agreement for material breach after written notice and a reasonable opportunity to cure when appropriate. This clause does not limit any statutory cancellation right that applies by law.",
  },
  {
    title: "Written Notices",
    body:
      "Written notices may be delivered by email, mail, hand delivery, or another written method the parties use for the project, unless a specific law requires a different method.",
  },
  {
    title: "Electronic Signatures and Counterparts",
    body:
      "Electronic signatures, scanned signatures, and signatures on separate counterparts are intended to be enforceable to the fullest extent allowed by law.",
  },
  {
    title: "Severability and Governing Law",
    body:
      "If one part of this agreement is found unenforceable, the remaining parts remain in effect to the extent allowed by law. This agreement is governed by New York law.",
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
