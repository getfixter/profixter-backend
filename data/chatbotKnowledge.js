// backend/data/chatbotKnowledge.js
module.exports = {
  meta: {
    brand: "Profixter",
    area: ["Nassau County, NY", "Suffolk County, NY"],
    phone: "631-599-1363",
    license: "HI-71484",
    estimateUrl: "https://profixter.com/estimate",
    membershipUrl: "https://profixter.com/membership",
    registerUrl: "https://profixter.com/register",
    promo: { code: "FIX10", desc: "10% off the first month of membership (new members only)" },
  },

  snippets: {
    // ── MEMBERSHIP ──────────────────────────────────────────────────────────
    membership: [
      "Home Care Membership = ongoing handyman maintenance, same trusted team, every visit.",
      "Month-to-month. No long-term contract required.",
      "Each visit covers up to 90 minutes of work and one primary task.",
      "Membership is based on plan level and technician availability — not a guaranteed daily service.",
      "After cancellation, membership stays active through the end of the current billing period.",
      "A failed or unpaid payment pauses service access until resolved.",
      "Active members receive 10% off qualifying home improvement projects (roofing, bathroom, kitchen).",
      "FIX10 = 10% off the first month of membership only. Does not stack with project discounts.",
    ],

    plans: [
      "Basic — $149/mo",
      "Plus — $249/mo",
      "Premium — $349/mo (most popular, priority scheduling)",
      "Elite — $499/mo",
      "All plans: visits up to 90 minutes each, same team, Nassau & Suffolk County only.",
    ],

    // ── PROJECTS ────────────────────────────────────────────────────────────
    projects: [
      "1-Day Roof Replacement — licensed full roof replacement typically completed in one day.",
      "Up to 50-year warranty available on roofing materials and workmanship.",
      "Full Bathroom Remodeling — design, demo, tile, fixtures, vanity, complete build-out.",
      "Full Kitchen Remodeling — cabinets, countertops, backsplash, appliances, lighting.",
      "All projects require a free estimate/consultation first — no fixed price without seeing the job.",
      "Financing available on qualifying projects.",
      "Active members receive 10% off qualifying projects.",
    ],

    estimate: [
      "Free estimates available at profixter.com/estimate.",
      "Fill out the estimate builder to describe your project and we'll follow up to schedule a consultation.",
      "Project pricing is confirmed after a consultation — chat cannot quote final prices.",
    ],

    // ── SERVICE & POLICIES ───────────────────────────────────────────────────
    serviceArea: [
      "We serve Nassau County and Suffolk County, NY only.",
      "Outside that area? I can add you to the waitlist for future expansion.",
    ],

    bookingRules: [
      "Booking is available after subscription is active and confirmed.",
      "Visit scheduling happens on the membership booking page, not in chat.",
    ],

    cancellation: [
      "Cancellation is handled by phone only. Number provided after confirming active subscriber status.",
      "Membership stays active through the end of the billing period after cancellation.",
      "Missed payment pauses service until payment is resolved.",
    ],

    trust: [
      "Licensed and insured. License #HI-71484.",
      "9+ years on Long Island.",
      "5.0 Google rating.",
      "Background-checked, personally vetted team.",
      "Same technicians — your team learns your home over time.",
    ],

    faqs: [
      "Q: Is there a free trial?\nA: No free trial. Membership starts with your first billing date.",
      "Q: Can I cancel anytime?\nA: Yes, by phone. Membership stays active through the current billing period.",
      "Q: How often can I book a visit?\nA: Based on plan and availability. Not a guaranteed daily or every-3-day service.",
      "Q: What's included in a membership visit?\nA: Handyman tasks up to 90 minutes — minor repairs, installs, maintenance. One primary task per visit.",
      "Q: Do you do plumbing or electrical?\nA: Light handyman-level tasks. Large-scope work moves into project territory.",
      "Q: Are project estimates free?\nA: Yes, free estimate at profixter.com/estimate.",
      "Q: Is financing available?\nA: Yes, on qualifying projects (roofing, bathroom, kitchen).",
      "Q: Do members get a discount on projects?\nA: Yes — active members get 10% off qualifying home improvement projects.",
      "Q: Do you serve renters?\nA: Membership is for homeowners and property managers/landlords (per property address).",
    ],

    waitlist: [
      "Outside Nassau/Suffolk? Provide name, email, phone, and ZIP to join the expansion waitlist.",
    ],
  },

  toModelContext() {
    const s = this.snippets;
    const m = this.meta;
    return [
      `BRAND: ${m.brand} | Phone: ${m.phone} | License: ${m.license}`,
      `SERVICE AREA:\n- ${m.area.join("\n- ")}`,
      `MEMBERSHIP:\n- ${s.membership.join("\n- ")}`,
      `PLANS:\n- ${s.plans.join("\n- ")}`,
      `PROJECTS:\n- ${s.projects.join("\n- ")}`,
      `ESTIMATE:\n- ${s.estimate.join("\n- ")}`,
      `TRUST:\n- ${s.trust.join("\n- ")}`,
      `BOOKING RULES:\n- ${s.bookingRules.join("\n- ")}`,
      `CANCELLATION:\n- ${s.cancellation.join("\n- ")}`,
      `PROMO:\n- ${m.promo.code} = ${m.promo.desc}`,
      `WAITLIST:\n- ${s.waitlist.join("\n- ")}`,
      `FAQ:\n${s.faqs.join("\n")}`,
    ].join("\n\n");
  },
};
