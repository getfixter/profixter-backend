/*
 * The pages the chat may send someone to. Live pages only: the retired
 * /home-support ("Profixter AI") and Shower Studio URLs must never come back
 * (scripts/test_chatbot_lead_rules.js fails if any reply names one).
 */
const ABSOLUTE_URLS = {
  book: "https://profixter.com/book",
  membership: "https://profixter.com/membership/plans",
  projects: "https://profixter.com/projects#estimate",
  fullDay: "https://profixter.com/book?visit=full-day",
  gift: "https://profixter.com/gift",
  signup: "https://profixter.com/signup",
};

const CALLBACK_CONFIRMATION_MARKER = "Reply \"Yes, call me\"";

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function includesAny(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

function extractPhoneNumber(value) {
  const text = String(value || "");
  const match = text.match(
    /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/
  );
  return match ? match[0].trim() : "";
}

function wantsPhoneCall(value) {
  const text = normalizeText(value);
  if (!text) return false;
  return [
    /\bcall me\b/,
    /\bphone call\b/,
    /\bcan someone call\b/,
    /\bhave someone call\b/,
    /\bplease call\b/,
    /\btalk to someone\b/,
    /\bspeak to someone\b/,
    /\bcontact me by phone\b/,
    /\bcall back\b/,
    /\bcallback\b/,
  ].some((pattern) => pattern.test(text));
}

function confirmsPhoneCall(value) {
  const text = normalizeText(value);
  if (!text) return false;
  return (
    /\b(yes|yep|yeah|correct|confirm|confirmed|please|ok|okay|sure)\b/.test(
      text
    ) &&
    /\b(call|phone|callback|call back)\b/.test(text)
  );
}

function declinesPhoneCall(value) {
  const text = normalizeText(value);
  if (!text) return false;
  return /^(no|no thanks|not now|nevermind|never mind|cancel|do not call)\b/.test(
    text
  );
}

function isAwaitingCallbackConfirmation(messages = []) {
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message?.role === "assistant");
  if (!lastAssistant) return false;
  return (
    lastAssistant?.meta?.kind === "callback_confirmation_prompt" ||
    String(lastAssistant?.content || "").includes(CALLBACK_CONFIRMATION_MARKER)
  );
}

function hasCallbackNotification(messages = []) {
  return messages.some(
    (message) => message?.meta?.kind === "callback_admin_notified"
  );
}

/*
 * Which page fits the message, checked from the most specific product to the
 * most general. Order matters: "gift a membership" is a gift, not a plan
 * question; "free first visit" is the new-customer offer, not a paid visit.
 *
 * "kitchen" or "bathroom" alone is not a project: "fix my bathroom faucet" is
 * a handyman visit. It takes remodel/renovation words (or "new kitchen") to
 * mean the estimate path.
 */
function getRoutingRecommendation(value) {
  const text = normalizeText(value);
  if (!text) return null;

  if (includesAny(text, ["gift"])) {
    return {
      type: "gift",
      label: "Gift a Membership",
      url: ABSOLUTE_URLS.gift,
      reason:
        "You can give a Profixter membership as a gift. The gift page shows every plan and length with its price.",
    };
  }

  if (includesAny(text, ["full day", "full-day", "whole day", "all day", "entire day"])) {
    return {
      type: "full_day",
      label: "Full Day Fixter",
      url: ABSOLUTE_URLS.fullDay,
      reason:
        "For a longer list, Full Day Fixter gives you one Fixter for about 8 hours. The booking page shows the price and the open days.",
    };
  }

  const projectKeywords = [
    "renovation",
    "renovate",
    "remodel",
    "roof",
    "siding",
    "new kitchen",
    "new bathroom",
    "addition",
    "new house",
    "build house",
    "full house",
    "whole home",
    "general contractor",
    "contractor",
    "estimate",
    "quote",
    "multi day",
    "multi-day",
    "structural",
  ];
  if (includesAny(text, projectKeywords)) {
    return {
      type: "projects",
      label: "Renovation Estimate",
      url: ABSOLUTE_URLS.projects,
      reason:
        "This sounds like larger project work, so the Renovation Estimate form is the right path.",
    };
  }

  if (/\bfree\b/.test(text) && /\b(visit|first|handyman|offer)\b/.test(text)) {
    return {
      type: "free_visit",
      label: "First Visit Free",
      url: ABSOLUTE_URLS.signup,
      reason:
        "New customers get their first handyman visit free: up to 90 minutes of labor, one per customer, no card needed, materials not included, subject to availability. Create an account and add your home, then book it on the Book page.",
    };
  }

  const membershipKeywords = [
    "membership",
    "member",
    "subscription",
    "subscribe",
    "monthly",
    "plan",
    "plans",
    "recurring",
    "ongoing",
    "maintenance",
    "many jobs",
    "multiple jobs",
    "priority",
    "rush visit",
    "rush visits",
  ];
  if (includesAny(text, membershipKeywords)) {
    return {
      type: "membership",
      label: "Membership",
      url: ABSOLUTE_URLS.membership,
      reason:
        "This sounds like ongoing home help, so Membership is the best fit. You can compare the plans here.",
    };
  }

  const bookingKeywords = [
    "book",
    "booking",
    "appointment",
    "schedule",
    "available",
    "availability",
    "slot",
    "next opening",
    "next time",
    "handyman",
    "one time",
    "one-time",
    "visit",
    "fix",
    "repair",
    "install",
    "mount",
    "faucet",
    "fixture",
    "drywall",
    "caulk",
    "shelf",
    "shelves",
    "mirror",
    "furniture",
    "hang",
  ];
  if (includesAny(text, bookingKeywords)) {
    return {
      type: "book",
      label: "Book Handyman",
      url: ABSOLUTE_URLS.book,
      reason:
        "For one small handyman task, the fastest next step is the booking page.",
    };
  }

  return null;
}

/*
 * Route straight to a page only when the visitor is trying to act (book, buy,
 * join, get a price). A question ("what does Plus include?") goes to the AI,
 * which has the same facts and can answer it.
 */
function shouldRouteToProductPage(value, recommendation = getRoutingRecommendation(value)) {
  const text = normalizeText(value);
  if (!text || !recommendation) return false;

  const directRoutingIntent = [
    "book",
    "booking",
    "appointment",
    "schedule",
    "available",
    "availability",
    "slot",
    "next opening",
    "next time",
    "send someone",
    "need someone",
    "want someone",
    "need a handyman",
    "come out",
    "come to my house",
    "hire",
    "sign up",
    "join",
    "become a member",
    "estimate",
    "quote",
    "price",
    "pricing",
    "cost",
    "how much",
    "plans",
  ];
  if (includesAny(text, directRoutingIntent)) {
    return true;
  }

  if (recommendation.type === "gift") {
    return includesAny(text, ["buy", "give", "purchase", "send", "order"]);
  }

  if (recommendation.type === "free_visit") {
    return includesAny(text, ["claim", "get my", "get a", "use my", "redeem"]);
  }

  if (recommendation.type === "membership") {
    return includesAny(text, ["membership", "member", "monthly", "recurring", "ongoing"]);
  }

  if (recommendation.type === "projects") {
    return includesAny(text, [
      "renovation",
      "remodel",
      "project",
      "general contractor",
      "contractor",
      "build",
      "new roof",
      "new siding",
      "new kitchen",
      "new bathroom",
    ]);
  }

  if (recommendation.type === "book") {
    return includesAny(text, ["handyman", "one time", "one-time", "visit"]);
  }

  return false;
}

function buildRoutingReply(recommendation) {
  if (!recommendation) return "";
  return `${recommendation.reason}\n\nGo here: ${recommendation.url}`;
}

/** The main pages, one per line, for replies that point somewhere instead of collecting a lead. */
function servicePageLines() {
  return [
    `- Membership plans: ${ABSOLUTE_URLS.membership}`,
    `- Book a visit: ${ABSOLUTE_URLS.book}`,
    `- Renovation Estimate: ${ABSOLUTE_URLS.projects}`,
  ];
}

function buildCallbackConfirmationPrompt() {
  return [
    "I can ask the Profixter team to call you.",
    "",
    "Just to confirm, do you want a phone call from us?",
    `${CALLBACK_CONFIRMATION_MARKER} and include the best phone number if it is not already on your account.`,
    "",
    "If you are trying to book, choose the right page instead:",
    ...servicePageLines(),
  ].join("\n");
}

function buildDeclinedCallbackReply() {
  return [
    "No problem. If you are trying to book or request service, use the right page:",
    ...servicePageLines(),
  ].join("\n");
}

module.exports = {
  ABSOLUTE_URLS,
  CALLBACK_CONFIRMATION_MARKER,
  buildCallbackConfirmationPrompt,
  buildDeclinedCallbackReply,
  buildRoutingReply,
  confirmsPhoneCall,
  declinesPhoneCall,
  extractPhoneNumber,
  getRoutingRecommendation,
  hasCallbackNotification,
  isAwaitingCallbackConfirmation,
  shouldRouteToProductPage,
  wantsPhoneCall,
};
