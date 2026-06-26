// backend/data/chatbotKnowledge.js
module.exports = {
  meta: {
    brand: "Profixter",
    area: ["Nassau County, NY", "Suffolk County, NY"],
    localBase: "Babylon, Long Island",
    phone: "631-599-1363",
    license: "HI-71484",
    aiUrl: "https://profixter.com/home-support",
    bookUrl: "https://profixter.com/book",
    membershipUrl: "https://profixter.com/membership",
    projectsUrl: "https://profixter.com/projects#estimate",
    aboutUrl: "https://profixter.com/about",
    promo: {
      code: "FIX10",
      desc: "10% off the first month of Membership for new Members when active.",
    },
  },

  snippets: {
    products: [
      "Profixter is a modern AI-powered home platform for Long Island homeowners.",
      "The four customer products are Profixter AI, Book Handyman, Membership, and Renovation.",
      "Profixter AI is the free temporary AI assistant for home questions, photos, PDFs, quotes, agreements, safety concerns, maintenance, repairs, renovation planning, and DIY-or-hire decisions.",
      "Book Handyman is the $99 One-Time Visit for one predefined small handyman task, up to 90 minutes.",
      "Membership is for homeowners who want ongoing home maintenance, recurring small jobs, seasonal care, and better long-term value.",
      "Renovation is for larger work such as roofing, siding, kitchens, bathrooms, full house renovations, build new house, additions, structural work, and multi-day projects.",
      "About Us explains the company story, Long Island roots, trust, and how Profixter works.",
    ],

    oneTimeVisit: [
      "One-Time Visits cost $99 and include up to 90 minutes for one predefined small handyman task.",
      "Customers choose the task, date/time, notes, and photos before Stripe Checkout.",
      "Payment happens after slot selection. Admin approval happens after payment.",
      "Paid One-Time Visit requests remain Pending until Profixter reviews and approves the job.",
      "Customers can book multiple One-Time Visits as long as each is paid separately and the selected slot is available.",
      "Cancellation or reschedule requests require calling Profixter at 631-599-1363.",
      "If the job cannot be approved or is outside scope before service, the customer receives a full refund.",
      "Profixter brings tools. Customers should have required materials ready when materials are needed.",
      "One-Time Visit tasks include replacing a light fixture, replacing a faucet, patching a small hole, painting a door, TV mounting, caulking and sealing, shelves and mirrors, assembling small furniture, wall hangings, and small fixes.",
    ],

    membership: [
      "Use the customer-facing words Membership, Member, and Become a Member. Avoid saying subscription unless the user asks about billing mechanics.",
      "Membership is better for homeowners who expect to need help more than once.",
      "Members can request ongoing handyman help without paying $99 every visit.",
      "Membership offers better long-term value, more service flexibility, and plan-dependent benefits such as priority scheduling, rush visit benefits, and project discounts.",
      "Membership booking requests are limited by appointment capacity and active booking rules, not by a hard monthly visit limit.",
      "After cancellation, Membership remains active through the end of the current billing period.",
      "A failed or unpaid payment can pause Membership access until resolved.",
      "Members may receive discounts on larger projects.",
    ],

    plans: [
      "Basic - $149/mo",
      "Plus - $249/mo",
      "Premium - $349/mo; often positioned as the stronger plan for priority-oriented homeowners.",
      "Elite - $499/mo",
      "All plans serve Nassau and Suffolk County only and are subject to appointment availability and active booking rules.",
    ],

    renovation: [
      "Profixter handles larger projects as a General Contractor.",
      "Renovation Estimate is the right path for roofing, siding, kitchens, bathrooms, full house renovation, build new house, additions, multi-day work, major electrical or plumbing remodels, structural work, or projects larger than a One-Time Visit.",
      "Roofing is often completed in one day and may include a 5-year labor warranty depending on the project terms.",
      "Siding can include unique siding options and a custom look, with a 5-year labor warranty depending on the project terms.",
      "Kitchen and bathroom projects are estimated after consultation because layout, materials, permits, and scope matter.",
      "Some larger projects may qualify for up to 12 months of Membership.",
      "Project pricing is confirmed after a consultation. Profixter AI should not invent final prices.",
    ],

    documents: [
      "Users can upload contractor quotes, agreements, scopes, and PDFs to Profixter AI for a practical homeowner opinion.",
      "Document review is not legal advice.",
      "Helpful review topics include unclear scope, exclusions, payment schedule, materials, warranty, change orders, permits, timeline, and red flags.",
    ],

    serviceArea: [
      "Profixter serves Long Island homeowners in Nassau County and Suffolk County, NY.",
      "Profixter has local Babylon roots.",
      "Outside Nassau or Suffolk, Profixter AI can still give general homeowner guidance, but Profixter service may not be available.",
    ],

    trust: [
      "Profixter is licensed and insured. License #HI-71484.",
      "Profixter is a local Long Island company built to make home help easier and more reliable.",
      "Photos and notes are collected before visits so the team can review the job.",
      "A real admin review happens before One-Time Visits are approved.",
      "Larger work has a separate estimate path so small handyman visits are not stretched into renovation projects.",
    ],

    appliancePolicy: [
      "Profixter does not offer appliance repair.",
      "Never present appliance repair, appliance diagnostics, warranty repair, or standalone appliance service as a Profixter service.",
      "For appliance problems, suggest the manufacturer, warranty provider, manual, or a qualified appliance repair specialist.",
      "For renovation planning, Profixter may help coordinate layout, measurements, rough-ins, delivery timing, or handoffs with an appliance vendor or licensed installer, but not appliance repair.",
    ],

    recommendationRules: [
      "Recommend Book Handyman when the user has one small predefined repair or install that likely fits a 90-minute visit.",
      "Recommend Membership when the user mentions many small tasks, recurring maintenance, seasonal upkeep, or wanting ongoing peace of mind.",
      "Recommend Renovation Estimate when the user mentions roofing, siding, kitchens, bathrooms, additions, full house renovation, build new house, structural work, multi-day work, or anything outside One-Time Visit scope.",
      "Recommendations should be brief, natural, and helpful. Do not aggressively advertise.",
    ],

    faqs: [
      "Q: What is Profixter?\nA: Profixter is an AI-powered home platform and Long Island home service company with Profixter AI, Book Handyman, Membership, and Renovation.",
      "Q: How much is a handyman visit?\nA: A One-Time Visit is $99 for up to 90 minutes for one predefined small handyman task, pending admin approval after payment.",
      "Q: What is Membership?\nA: Membership is ongoing home support for homeowners who need recurring help, seasonal maintenance, more flexibility, and better long-term value than paying $99 each visit.",
      "Q: Can I book multiple One-Time Visits?\nA: Yes. Each One-Time Visit is paid separately and depends on slot availability.",
      "Q: Do Members save money?\nA: Membership can save money for homeowners who need help more than once and may include plan-dependent benefits such as priority scheduling, rush visit benefits, and project discounts.",
      "Q: What renovations do you do?\nA: Roofing, siding, kitchens, bathrooms, full house renovation, build new house, additions, and other larger home projects through the Renovation Estimate path.",
      "Q: Are you licensed and insured?\nA: Yes. Profixter is licensed and insured. License #HI-71484.",
      "Q: What areas do you serve?\nA: Nassau and Suffolk Counties on Long Island, with local Babylon roots.",
      "Q: Can I upload contractor quotes or agreements?\nA: Yes. Profixter AI can review quotes, agreements, scopes, and PDFs as a practical homeowner opinion, not legal advice.",
      "Q: Do you repair appliances?\nA: No. Profixter does not offer appliance repair. Use the manufacturer, warranty provider, or a qualified appliance repair specialist.",
      "Q: How do estimates work?\nA: Larger work starts with a Renovation Estimate. Profixter reviews the project and follows up for consultation before pricing is confirmed.",
    ],
  },

  toModelContext() {
    const s = this.snippets;
    const m = this.meta;
    return [
      `BRAND: ${m.brand} | Phone: ${m.phone} | License: ${m.license} | Local base: ${m.localBase}`,
      `LINKS: Profixter AI ${m.aiUrl} | Book Handyman ${m.bookUrl} | Membership ${m.membershipUrl} | Renovation Estimate ${m.projectsUrl} | About ${m.aboutUrl}`,
      `SERVICE AREA:\n- ${m.area.join("\n- ")}`,
      `PRODUCTS:\n- ${s.products.join("\n- ")}`,
      `ONE-TIME VISIT:\n- ${s.oneTimeVisit.join("\n- ")}`,
      `MEMBERSHIP:\n- ${s.membership.join("\n- ")}`,
      `PLANS:\n- ${s.plans.join("\n- ")}`,
      `RENOVATION:\n- ${s.renovation.join("\n- ")}`,
      `DOCUMENT REVIEW:\n- ${s.documents.join("\n- ")}`,
      `TRUST:\n- ${s.trust.join("\n- ")}`,
      `APPLIANCE POLICY:\n- ${s.appliancePolicy.join("\n- ")}`,
      `RECOMMENDATION RULES:\n- ${s.recommendationRules.join("\n- ")}`,
      `PROMO:\n- ${m.promo.code} = ${m.promo.desc}`,
      `FAQ:\n${s.faqs.join("\n")}`,
    ].join("\n\n");
  },
};
