// backend/data/chatbotKnowledge.js
module.exports = {
  meta: {
    brand: "Mr. Fixter (Profixter)",
    area: ["Nassau County, NY", "Suffolk County, NY"],
    registerUrl: "https://profixter.com/register",
    promo: { code: "FIX10", desc: "10% off first month" },
  },

  // Short, factual snippets the bot can quote from
  snippets: {
    valuePitch: [
      "Unlimited handyman visits for homeowners in Nassau & Suffolk.",
      "One task per 90-minute visit, as often as every 3 days.",
      "Trip charge AND labor are included in your subscription.",
      "First 7 days are a free trial.",
      "No hidden fees.",
    ],

    serviceArea: [
      "We currently serve only Nassau County and Suffolk County, NY.",
      "If you're outside that area, I can add you to our waitlist for future expansion.",
    ],

    plans: [
      "Basic — $149/mo",
      "Plus — $249/mo",
      "Premium — $349/mo (recommended: best value and priority)",
      "Elite — $499/mo",
      "All plans include: unlimited visits, one 90-minute task per visit, as often as every 3 days.",
    ],

    bookingRules: [
      "Bookings are available only after subscription is active.",
      "All bookings must be made on the booking page (not in chat).",
    ],

    cancellation: [
      "Cancellation happens ONLY by phone call.",
      "I’ll share the phone number only after I confirm you’re a current paid subscriber who wants to cancel.",
    ],

    promo: [
      "If price is a concern, you can use promo code FIX10 for 10% off the first month.",
    ],

    waitlist: [
      "Outside Nassau/Suffolk? I can collect your name, email, phone, and ZIP to join the waitlist.",
    ],

    faqs: [
      "Q: What’s included?\nA: Typical handyman tasks (minor repairs, installs, maintenance). One task per 90-min visit.",
      "Q: Any extra trip or labor fees?\nA: Trip charge and labor are already included in your subscription.",
      "Q: How soon can I book?\nA: Right after you subscribe. Then you can choose a time on the booking page.",
      "Q: Do you service renters or just homeowners?\nA: We focus on homeowners, but property managers and landlords can subscribe per property address.",
      "Q: Do you cover plumbing/electrical?\nA: Light/handyman-level tasks are fine. If a task is borderline or large-scope, we’ll confirm at booking.",
      "Q: Do you work outside Nassau/Suffolk?\nA: Not yet. I can add you to the waitlist.",
    ],
  },

  // Minimal helper text the backend can embed for the model
  toModelContext() {
    const s = this.snippets;
    return [
      `SERVICE AREA:\n- ${this.meta.area.join("\n- ")}`,
      `REGISTER URL:\n- ${this.meta.registerUrl}`,
      `PROMO:\n- ${this.meta.promo.code} = ${this.meta.promo.desc}`,
      `VALUE PITCH:\n- ${s.valuePitch.join("\n- ")}`,
      `PLANS:\n- ${s.plans.join("\n- ")}`,
      `BOOKING RULES:\n- ${s.bookingRules.join("\n- ")}`,
      `CANCELLATION:\n- ${s.cancellation.join("\n- ")}`,
      `WAITLIST:\n- ${s.waitlist.join("\n- ")}`,
      `FAQ:\n- ${s.faqs.join("\n- ")}`,
    ].join("\n\n");
  },
};
