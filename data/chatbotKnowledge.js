// backend/data/chatbotKnowledge.js
//
// What the website chat assistant knows about Profixter.
//
// Every fact here is copied from the live website or the server, never written
// fresh: plan prices and FAQ answers from FrontEnd app/data/content.ts and
// app/data/membership-faq.ts, company facts from FrontEnd lib/business.ts, the
// One-Time and Full Day defaults from utils/oneTimeVisitSettings and
// utils/fullDayVisitSettings, gift lengths from utils/gifts/giftConfig. When
// one of those changes, change it here too. If something is not in here, the
// assistant should say it does not know and offer the phone number - not guess.
//
// Links use only pages that exist. The retired /home-support ("Profixter AI")
// and Shower Studio pages must never appear: scripts/test_chatbot_lead_rules.js
// checks this file for them.
module.exports = {
  meta: {
    brand: "Profixter",
    area: ["Suffolk County, NY", "Nassau County, NY"],
    localBase: "Lindenhurst (Town of Babylon), Long Island",
    phone: "631-599-1363",
    license: "HI-71484",
    licensePhrase: "Suffolk County home improvement license HI-71484",
    hours: "8 AM - 6 PM, seven days a week",
    plansUrl: "https://profixter.com/membership/plans",
    membershipUrl: "https://profixter.com/membership",
    bookUrl: "https://profixter.com/book",
    fullDayUrl: "https://profixter.com/book?visit=full-day",
    signupUrl: "https://profixter.com/signup",
    giftUrl: "https://profixter.com/gift",
    projectsUrl: "https://profixter.com/projects#estimate",
    servicesUrl: "https://profixter.com/services",
    aboutUrl: "https://profixter.com/about",
  },

  snippets: {
    products: [
      "Profixter is a Long Island handyman and home-maintenance company based in Lindenhurst, serving Nassau and Suffolk Counties.",
      "Its main product is the handyman Membership: a monthly plan for your home, so the same team handles the small jobs and upkeep as they come up.",
      "New customers can have their first visit free (see FIRST VISIT FREE).",
      "Book Handyman is the $99 One-Time Visit for one predefined small handyman task, up to 90 minutes.",
      "Full Day Fixter is one Fixter for one day, about 8 hours, to work through a longer list.",
      "Gift memberships let someone give a Profixter membership to another homeowner.",
      "Larger work (roofing, siding, kitchens, bathrooms, renovations) goes through a separate Renovation Estimate.",
    ],

    firstVisitFree: [
      "New customers get their first handyman visit free: up to 90 minutes of standard handyman labor.",
      "One free visit per customer. No membership required and no credit card needed to book it.",
      "Materials are not included in the free visit. Scheduling is subject to availability.",
      "It is for homes in Nassau and Suffolk Counties.",
      "To use it, create an account (signupUrl), add the home, and book the visit on the Book page (bookUrl).",
      "Members do not get this offer; it is for new customers.",
    ],

    membership: [
      "Use the customer-facing words Membership, Member and Become a Member. 'Subscription' is fine when the user asks about billing.",
      "Membership isn't a set number of visits per month. Members book as often as they need; the plan sets how many visits can be booked at the same time: Basic 1, Plus, Premium and Elite up to 2. Once a visit is done, they can book the next one. Scheduling is subject to availability.",
      "Each standard visit is up to 90 minutes. If a job takes longer, the work can be split into multiple visits based on availability.",
      "There is no extra labor charge per visit for Members.",
      "Materials: Basic includes labor only. Plus and above include basic materials for small tasks. Larger materials, special-order items, fixtures, appliances and project materials are quoted or approved separately.",
      "Plans are month-to-month with no long-term contract. If a Member cancels, the membership stays active through the end of the current billing period and they are not charged again.",
      "A failed or unpaid payment can pause Membership access until it is resolved.",
      "Membership is usually better for homeowners who expect to need help more than once.",
      "To book as a Member: choose the property, pick an available slot, add notes and photos, and the team confirms the appointment.",
    ],

    plans: [
      "Basic - $149/mo: book 1 visit at a time, as often as you need; small fixes and regular maintenance; labor only.",
      "Plus - $249/mo: everything in Basic; book up to 2 visits at a time; basic materials for small tasks; priority on open scheduling slots.",
      "Premium - $349/mo: everything in Plus; one Priority Visit per month.",
      "Elite - $499/mo: everything in Premium; two Priority Visits per month; one full project day per month (up to 8 hours); 10% off home improvement projects (roofing, remodeling, kitchen).",
      "Priority Visits help when a Member needs service before the next standard appointment slot, subject to Fixter availability.",
      "All plans serve Nassau and Suffolk County only. Compare plans at plansUrl.",
    ],

    oneTimeVisit: [
      "A One-Time Visit costs $99 and includes up to 90 minutes for one predefined small handyman task. The Book page always shows the current price.",
      "The customer chooses the task, date and time, adds notes and photos, then pays at checkout.",
      "Paid One-Time Visit requests stay Pending until Profixter reviews and approves the job.",
      "Customers can book multiple One-Time Visits as long as each is paid separately and the selected slot is available.",
      "Cancellation or reschedule requests require calling Profixter at 631-599-1363.",
      "If the job cannot be approved or is outside scope before service, the customer receives a full refund.",
      "Profixter brings tools. Customers should have required materials ready when materials are needed.",
      "Examples: replacing a light fixture, replacing a faucet, patching a small hole, painting a door, TV mounting, caulking and sealing, shelves and mirrors, assembling small furniture, wall hangings and small fixes.",
    ],

    fullDay: [
      "Full Day Fixter: one Fixter is yours for approximately 8 hours to work through your list.",
      "It is $499 when it is not included with a plan. Elite includes one Full Day per membership month. The Book page shows the live price and whether a day is included.",
      "Book it at fullDayUrl. Cancellations go through 631-599-1363.",
      "Kitchen or bathroom remodeling, roofing, siding and larger renovations are not a Full Day job; they go through the Renovation Estimate.",
    ],

    gifts: [
      "Gift memberships can be bought at giftUrl for any of the four plans (Basic, Plus, Premium, Elite).",
      "Gift lengths offered are 1, 2, 3, 6 or 12 months. The gift page shows the exact price for each plan and length; do not quote gift prices.",
      "The person receiving the gift claims it from the gift they are sent.",
    ],

    renovation: [
      "Profixter handles larger projects as a General Contractor.",
      "The Renovation Estimate (projectsUrl) is the right path for roofing, siding, kitchens, bathrooms, full house renovation, additions, multi-day work, major electrical or plumbing remodels, structural work, or anything larger than a handyman visit.",
      "Project pricing is confirmed after a consultation. Never invent project prices.",
      "Elite Members get 10% off home improvement projects.",
    ],

    notHandymanWork: [
      "Appliance repair",
      "Painting entire rooms",
      "Large electrical work, such as panels and rewiring",
      "Plumbing remodels and re-piping",
      "Roofing, siding and renovations (these go to the Renovation Estimate)",
      "Structural work and multi-day projects",
    ],

    serviceArea: [
      "Profixter serves homeowners in Suffolk County and Nassau County on Long Island.",
      "Outside Nassau or Suffolk, Profixter service is not available.",
    ],

    trust: [
      "Profixter is licensed and insured: Suffolk County home improvement license HI-71484. Do not call it a New York State license, and do not claim a Nassau County license.",
      "Hours: 8 AM - 6 PM, seven days a week.",
      "Photos and notes are collected before visits so the team can review the job.",
    ],

    appliancePolicy: [
      "Profixter does not offer appliance repair.",
      "Never present appliance repair, appliance diagnostics, warranty repair or standalone appliance service as a Profixter service.",
      "For appliance problems, suggest the manufacturer, the warranty provider, the manual, or a qualified appliance repair specialist.",
    ],

    recommendationRules: [
      "New customer, not sure where to start: the free first visit (create an account, then book).",
      "Recurring small jobs, upkeep, a growing to-do list, or wanting the same team: Membership (compare plans).",
      "One small predefined task: Book Handyman ($99 One-Time Visit).",
      "A long list that needs a whole day: Full Day Fixter.",
      "Buying for someone else: gift membership.",
      "Roofing, siding, kitchens, bathrooms, renovations, structural or multi-day work: Renovation Estimate.",
      "Recommendations should be brief, natural and helpful. Do not aggressively advertise.",
    ],

    faqs: [
      "Q: What is Profixter?\nA: A Long Island handyman membership for your home, serving Nassau and Suffolk Counties. Members book visits as often as they need; there are also $99 One-Time Visits, Full Day Fixter days, gift memberships, and renovation estimates for larger work.",
      "Q: Is the first visit free?\nA: For new customers, yes: up to 90 minutes of standard handyman labor, one per customer, no card needed, materials not included, subject to availability, for homes in Nassau and Suffolk.",
      "Q: How many visits do I get each month?\nA: Membership isn't a set number of visits per month. Book as often as you need - Basic lets you have one visit booked at a time, while Plus, Premium and Elite let you have up to two. Scheduling is subject to availability.",
      "Q: How much is a handyman visit?\nA: A One-Time Visit is $99 for up to 90 minutes for one predefined small handyman task, pending review after payment.",
      "Q: Are materials included?\nA: Basic includes labor only. Plus and above include basic materials for small tasks. Larger materials, special-order items, fixtures, appliances and project materials are quoted or approved separately.",
      "Q: How does cancellation work?\nA: Plans are month-to-month with no long-term contract. If you cancel, your membership stays active through the end of the current billing period and you will not be charged again.",
      "Q: What if my job takes longer than 90 minutes?\nA: The work can be split into multiple visits based on availability, or a Full Day Fixter covers about 8 hours.",
      "Q: What areas do you serve?\nA: Suffolk and Nassau Counties on Long Island.",
      "Q: Are you licensed and insured?\nA: Yes. Suffolk County home improvement license HI-71484.",
      "Q: Do you repair appliances?\nA: No. Use the manufacturer, warranty provider, or a qualified appliance repair specialist.",
      "Q: How do estimates work?\nA: Larger work starts with a Renovation Estimate. Profixter reviews the project and follows up for a consultation before pricing is confirmed.",
    ],
  },

  toModelContext() {
    const s = this.snippets;
    const m = this.meta;
    return [
      `BRAND: ${m.brand} | Phone: ${m.phone} | ${m.licensePhrase} | Based in: ${m.localBase} | Hours: ${m.hours}`,
      `LINKS (use only these): Plans ${m.plansUrl} | Membership ${m.membershipUrl} | Book a visit ${m.bookUrl} | Full Day ${m.fullDayUrl} | Create an account ${m.signupUrl} | Gift a membership ${m.giftUrl} | Renovation Estimate ${m.projectsUrl} | Services ${m.servicesUrl} | About ${m.aboutUrl}`,
      `SERVICE AREA:\n- ${s.serviceArea.join("\n- ")}`,
      `PRODUCTS:\n- ${s.products.join("\n- ")}`,
      `MEMBERSHIP:\n- ${s.membership.join("\n- ")}`,
      `PLANS:\n- ${s.plans.join("\n- ")}`,
      `FIRST VISIT FREE:\n- ${s.firstVisitFree.join("\n- ")}`,
      `ONE-TIME VISIT:\n- ${s.oneTimeVisit.join("\n- ")}`,
      `FULL DAY FIXTER:\n- ${s.fullDay.join("\n- ")}`,
      `GIFT MEMBERSHIPS:\n- ${s.gifts.join("\n- ")}`,
      `RENOVATION:\n- ${s.renovation.join("\n- ")}`,
      `NOT HANDYMAN WORK (member or not):\n- ${s.notHandymanWork.join("\n- ")}`,
      `TRUST:\n- ${s.trust.join("\n- ")}`,
      `APPLIANCE POLICY:\n- ${s.appliancePolicy.join("\n- ")}`,
      `RECOMMENDATION RULES:\n- ${s.recommendationRules.join("\n- ")}`,
      `FAQ:\n${s.faqs.join("\n")}`,
    ].join("\n\n");
  },
};
