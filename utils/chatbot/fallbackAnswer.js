/*
 * When the AI cannot answer (provider down, out of credit, timeout), the chat
 * still answers the common questions from the current business rules, with no
 * AI call - instead of "the chat could not answer". The facts mirror
 * data/chatbotKnowledge.js (Free Visit: no repairs or labor; One-Time Visit
 * $99, one small task, up to 90 minutes; Full Day; plans from $149/month;
 * Nassau and Suffolk). scripts/test_chatbot_answer.js pins them.
 */
const PHONE = "631-599-1363";

const ANSWERS = [
  {
    key: "free_visit",
    match: /free\s*visit|free\s*(estimate|consult|walk)|to-?do list/i,
    text: `The Free Visit is a free home visit: a Profixter team member walks through your to-do list with you and helps you choose the right service (a membership, a One-Time Visit or a Full Day). Repairs and labor are not included in the Free Visit. You can book it without an account at https://profixter.com/book/free.`,
  },
  {
    key: "one_time",
    match: /one[-\s]?time|single (job|visit)|\$\s?99|just one (job|thing)/i,
    text: `A One-Time Visit is $99 for one small handyman task, up to 90 minutes of work - no membership needed. Describe the job and pick a time at https://profixter.com/book/handyman.`,
  },
  {
    key: "full_day",
    match: /full[-\s]?day|whole day|all day/i,
    text: `A Full Day gives you one Fixter for about 8 hours to work through your list. See the details and open dates at https://profixter.com/book?visit=full-day.`,
  },
  {
    key: "membership",
    match: /member|plan|price|cost|how much|subscription|basic|plus|premium|elite|monthly|annual/i,
    text: `A Profixter Membership is your handyman plan for your home: labor is included for covered tasks, and you can book visits as often as you need (Basic has one visit booked at a time; the higher plans allow more). Plans start at $149 a month, and annual plans charge 10 months for 12. Compare them at https://profixter.com/membership/plans.`,
  },
  {
    key: "booking",
    match: /book|schedul|appointment|availab|when can|time slot|reserve/i,
    text: `You can book online: for a Free Visit go to https://profixter.com/book/free, and to get work done go to https://profixter.com/book/handyman - describe the job, pick an open time, then choose a One-Time Visit or a membership. Or call ${PHONE}.`,
  },
  {
    key: "area",
    match: /area|serve|nassau|suffolk|long island|town|where|zip|location/i,
    text: `Profixter serves Nassau and Suffolk counties on Long Island. When you enter your address while booking, the site confirms it is in our area.`,
  },
  {
    key: "renovation",
    match: /renovat|remodel|kitchen|bathroom|roof|siding|project|larger|big job|estimate/i,
    text: `For larger projects like kitchens, bathrooms, roofing or siding, ask for a renovation estimate at https://profixter.com/projects#estimate.`,
  },
  {
    key: "gift",
    match: /gift/i,
    text: `You can give a Profixter Membership as a gift at https://profixter.com/gift.`,
  },
];

const DEFAULT = `Profixter is a Long Island handyman company serving Nassau and Suffolk counties. You can book a Free Visit to go over your to-do list (https://profixter.com/book/free), book a handyman for a job (https://profixter.com/book/handyman), or compare membership plans (https://profixter.com/membership/plans). For anything else, call ${PHONE}.`;

/** The best canned answer for a question; `key` says which (for logs and tests). */
function fallbackAnswer(question) {
  const q = String(question || "");
  const hit = ANSWERS.find((a) => a.match.test(q));
  return hit ? { key: hit.key, text: hit.text } : { key: "default", text: DEFAULT };
}

module.exports = { fallbackAnswer, PHONE };
