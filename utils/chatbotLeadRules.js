const ABSOLUTE_URLS = {
  book: "https://profixter.com/book",
  membership: "https://profixter.com/membership",
  projects: "https://profixter.com/projects#estimate",
};

const CALLBACK_CONFIRMATION_MARKER = "Reply \"Yes, call me\"";

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
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

function getRoutingRecommendation(value) {
  const text = normalizeText(value);
  if (!text) return null;

  const projectKeywords = [
    "renovation",
    "remodel",
    "roof",
    "roofing",
    "siding",
    "kitchen",
    "bathroom",
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
  if (projectKeywords.some((keyword) => text.includes(keyword))) {
    return {
      type: "projects",
      label: "Renovation Estimate",
      url: ABSOLUTE_URLS.projects,
      reason:
        "This sounds like larger project work, so the Renovation Estimate form is the right path.",
    };
  }

  const membershipKeywords = [
    "membership",
    "member",
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
  if (membershipKeywords.some((keyword) => text.includes(keyword))) {
    return {
      type: "membership",
      label: "Membership",
      url: ABSOLUTE_URLS.membership,
      reason:
        "This sounds like ongoing home support, so Membership is the best place to compare plans.",
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
  if (bookingKeywords.some((keyword) => text.includes(keyword))) {
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
  if (directRoutingIntent.some((keyword) => text.includes(keyword))) {
    return true;
  }

  if (recommendation.type === "membership") {
    return ["membership", "member", "monthly", "recurring", "ongoing"].some(
      (keyword) => text.includes(keyword)
    );
  }

  if (recommendation.type === "projects") {
    return [
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
    ].some((keyword) => text.includes(keyword));
  }

  if (recommendation.type === "book") {
    return ["handyman", "one time", "one-time", "visit"].some((keyword) =>
      text.includes(keyword)
    );
  }

  return false;
}

function buildRoutingReply(recommendation) {
  if (!recommendation) return "";
  return `${recommendation.reason}\n\nGo here: ${recommendation.url}`;
}

function buildCallbackConfirmationPrompt() {
  return [
    "I can ask the Profixter team to call you.",
    "",
    "Just to confirm, do you want a phone call from us?",
    `${CALLBACK_CONFIRMATION_MARKER} and include the best phone number if it is not already on your account.`,
    "",
    "If you are trying to book, choose the right page instead:",
    `- Book Handyman: ${ABSOLUTE_URLS.book}`,
    `- Membership: ${ABSOLUTE_URLS.membership}`,
    `- Renovation Estimate: ${ABSOLUTE_URLS.projects}`,
  ].join("\n");
}

module.exports = {
  ABSOLUTE_URLS,
  CALLBACK_CONFIRMATION_MARKER,
  buildCallbackConfirmationPrompt,
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
