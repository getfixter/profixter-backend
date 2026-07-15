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

const CONTRACT_TERMS_VERSION = "PIH-NY-HI-2026-001";

const NY_SOURCE_URLS = Object.freeze([
  "https://ag.ny.gov/home-improvement-fact-sheet",
  "https://dos.ny.gov/news/new-york-department-states-division-consumer-protection-announces-top-10-consumer-assistance",
]);

const ATTORNEY_REVIEW_NOTE =
  "Developer note: these contract terms are draft operating text and must be reviewed by a New York construction attorney before production use.";

const CONTRACT_TERMS_SECTIONS = Object.freeze([
  {
    title: "Contract Documents",
    body:
      "This contract consists of the customer and property information, project description, scope of work, payment schedule, additional details, these terms, signature page, and the attached cancellation notice. Any change must be documented in writing.",
  },
  {
    title: "Scope, Materials, and Allowances",
    body:
      "Premium Island Homes Inc. will perform the work described in this contract. Materials, brands, model numbers, allowances, exclusions, permit responsibility, and special customer instructions are listed in the project sections when applicable. Items not listed are excluded unless added by written change order.",
  },
  {
    title: "Project Schedule",
    body:
      "Estimated start and completion dates are good-faith planning dates. Weather, permits, inspections, material availability, concealed conditions, customer delays, and approved change orders may affect the schedule.",
  },
  {
    title: "Price and Payment Schedule",
    body:
      "The customer agrees to pay the contract price according to the payment schedule in this contract. Progress payments should maintain a reasonable relationship to work performed, materials purchased, or other project costs.",
  },
  {
    title: "Progress Payments, Escrow, Bond, and Lien Notice",
    body:
      "New York home improvement guidance requires a contractor receiving payments before substantial completion to place those payments in a New York trust or escrow account, or provide a bond or contract of indemnity. If the contractor or subcontractor who performs the work is not paid, that party may have a claim against the customer's property under the Lien Law.",
  },
  {
    title: "Customer Right to Cancel",
    body:
      "The customer has an unconditional right to cancel this contract in writing until midnight of the third business day after signing. The cancellation deadline shown in this contract controls for this project.",
  },
  {
    title: "Change Orders",
    body:
      "Additional work, deleted work, material substitutions, price changes, and schedule changes must be documented and approved in writing before the changed work is performed.",
  },
  {
    title: "Permits and Inspections",
    body:
      "Permit responsibility is stated in the project details. Required municipal inspections and certificates may affect project scheduling and final payment timing.",
  },
  {
    title: "Customer Responsibilities",
    body:
      "The customer will provide reasonable access to the property, keep work areas available, secure pets and personal property, and promptly respond to project decisions needed for completion.",
  },
  {
    title: "Signatures",
    body:
      "By signing, the customer and Premium Island Homes Inc. acknowledge that they have reviewed this contract and received a copy before work begins.",
  },
]);

module.exports = {
  ATTORNEY_REVIEW_NOTE,
  COMPANY_INFO,
  CONTRACT_STATUSES,
  CONTRACT_TERMS_SECTIONS,
  CONTRACT_TERMS_VERSION,
  NY_SOURCE_URLS,
  WORK_TYPES,
};
