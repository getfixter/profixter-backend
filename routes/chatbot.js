// 📁 routes/chatbot.js
const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const Lead = require("../models/Lead");
const Conversation = require("../models/Conversation");
const knowledge = require("../data/chatbotKnowledge");
const {
  sendAdminLeadNotification,
} = require("../utils/adminLeadNotification");
const {
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
} = require("../utils/chatbotLeadRules");
const { consume } = require("../utils/rateLimit");
const { clientIp } = require("../utils/auth/clientIp");

// --- CONFIG ---
const { claudeAnswer, MODEL: CHAT_MODEL } = require("../utils/chatbot/claudeAnswer");
const { fallbackAnswer } = require("../utils/chatbot/fallbackAnswer");

const SYSTEM_PROMPT = `
You are the Profixter Assistant, the chat on profixter.com. Profixter is a Long Island handyman company serving Nassau and Suffolk County, NY. Its main product is a handyman Membership for your home: a monthly plan, and Members book visits as often as they need.

What Profixter offers (details are in the knowledge base - use only those facts):
1. MEMBERSHIP - the monthly handyman plan (Basic, Plus, Premium, Elite). Plans: https://profixter.com/membership/plans
2. FREE VISIT - a free home visit where a Profixter team member goes over the customer's to-do list and explains which service fits (membership, One-Time Visit or Full Day). It does NOT include any repairs or labor. No account needed: https://profixter.com/book/free
   BOOK A HANDYMAN - to get work done: describe the job, pick a time, then choose a One-Time Visit or a membership: https://profixter.com/book/handyman
3. ONE-TIME VISIT - $99 for one predefined small handyman task, up to 90 minutes: https://profixter.com/book
4. FULL DAY FIXTER - one Fixter for about 8 hours: https://profixter.com/book?visit=full-day
5. GIFT MEMBERSHIPS - give a membership to another homeowner: https://profixter.com/gift
6. RENOVATION ESTIMATE - roofing, siding, kitchens, bathrooms and other larger projects: https://profixter.com/projects#estimate

TONE: Warm, direct and confident, like a knowledgeable team member. Short replies (2-4 sentences) unless the user asks for detail. Plain text, no markdown headings. No fluff.

NEVER:
- Say "unlimited visits", "free trial", "book every 3 days" or any specific booking frequency, or "Mr. Fixter".
- Say "cancel anytime" (say: month-to-month, and the membership stays active through the end of the current billing period after cancellation).
- Invent a price, discount, promo code, guarantee, warranty, timeline, availability or policy that is not in the knowledge base. If you do not know, say so and offer 631-599-1363.
- Promise a booking, an appointment time or that a person will call. Only the booking pages and the callback flow do that.
- Offer appliance repair, or any work on the NOT HANDYMAN WORK list as a handyman visit.
- Link to any page other than the LINKS in the knowledge base. There is no separate AI product, photo upload, design studio or 3D tool - do not mention one.
- Call the license a New York State license.

ALWAYS:
- Use the words Membership, Member and Become a Member. "Subscription" is fine when the user asks about billing.
- If the user is trying to book, schedule, find availability or make an appointment, send them to the right page instead of collecting a lead.
- Only treat a phone call as a callback request after the user explicitly confirms they want a phone call.
- If asked to cancel, confirm they are an active Member before sharing the phone number for cancellations.
- For danger at home (gas smell, sparking, flooding, smoke, carbon monoxide), tell them to leave if unsafe and contact 911 or the utility first.
- Keep the Profixter brand name consistent.
`;

const KNOWLEDGE_BLOCK = knowledge.toModelContext();

function sendSseReply(res, text) {
  res.write(`data: ${JSON.stringify({ token: text })}\n\n`);
  res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  return res.end();
}

function leadAddress(leadDoc) {
  if (!leadDoc) return "";
  return [
    leadDoc.address_line1,
    leadDoc.city,
    leadDoc.state,
    leadDoc.zip,
    leadDoc.county,
  ]
    .filter(Boolean)
    .join(", ");
}

function phoneFromMessages(messages = []) {
  for (const message of [...messages].reverse()) {
    const phone = extractPhoneNumber(message?.content);
    if (phone) return phone;
  }
  return "";
}

async function sendAiCallbackAdminEmail({
  leadDoc,
  input,
  channel,
  visitorId,
  sourcePage,
  phoneOverride,
}) {
  const phone = phoneOverride || leadDoc?.phone || extractPhoneNumber(input);
  await sendAdminLeadNotification({
    subject: "AI CALL REQUEST",
    leadId: leadDoc?._id ? String(leadDoc._id) : "",
    leadType: "AI Callback Request",
    service: "Phone call requested from AI assistant",
    name: leadDoc?.name,
    email: leadDoc?.email,
    phone,
    address: leadAddress(leadDoc),
    message: [
      String(input || "").trim(),
      visitorId ? `Visitor ID: ${visitorId}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
    contactPref: "phone",
    sourcePage: sourcePage || `chatbot:${channel || "web"}`,
    submittedAt: new Date(),
  });
}

async function saveAssistantBranch(convo, input, reply, meta = {}) {
  if (!convo) return;
  convo.messages.push({ role: "user", content: input });
  convo.messages.push({ role: "assistant", content: reply, meta });
  convo.lastMessageAt = new Date();
  await convo.save();
}

// ========== AI CALL (Streaming Support) ==========
/*
 * Claude answers (utils/chatbot/claudeAnswer.js). If it cannot - no key, a
 * provider error, a timeout, a refusal - the failure is logged with its code
 * (never a key) and the visitor still gets a correct answer from the knowledge
 * base (utils/chatbot/fallbackAnswer.js) instead of an error.
 */
async function answerQuestion(history, onChunk, question) {
  let streamed = "";
  try {
    return await claudeAnswer({
      system: SYSTEM_PROMPT,
      knowledge: KNOWLEDGE_BLOCK,
      history,
      onToken: (t) => {
        streamed += t;
        if (onChunk) onChunk(t);
      },
    });
  } catch (error) {
    const fallback = fallbackAnswer(question);
    console.error(JSON.stringify({ event: "chatbot_provider_failed", model: CHAT_MODEL, code: error.code || "error", status: error.status ?? null, partial: streamed.length > 0, fallback: fallback.key }));
    // Part of an answer already reached the visitor: finish politely rather than start over.
    const tail = streamed ? `

Sorry, I was cut off. ${fallback.text}` : fallback.text;
    if (onChunk) onChunk(tail);
    return (streamed + tail).trim();
  }
}

/*
 * Abuse limits for the public chat. Every message can cost an OpenAI call and
 * write a Lead, so a script must not be able to loop it. A real visitor sends a
 * handful of messages a minute at most; 30 per 10 minutes per IP leaves room for
 * a long conversation (and for a household or office sharing one address)
 * while capping what one source can spend. Inputs are capped too: nobody types
 * 1,000 characters into a support bubble, and a pasted essay is all tokens.
 *
 * Answered as an SSE message, not a 429, because the widget is already reading
 * a stream and shows the `error` text to the visitor as it is.
 */
const CHAT_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 };
const MAX_INPUT_CHARS = 1000;
const MAX_VISITOR_ID_CHARS = 100;
const RATE_LIMITED_MESSAGE =
  "You have sent a lot of messages in a short time. Please wait a few minutes and try again, or call Profixter at 631-599-1363.";

function chatbotRateLimit(req, res, next) {
  const result = consume({ key: `chatbot:${clientIp(req) || "unknown"}`, ...CHAT_LIMIT });
  if (result.allowed) return next();
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Retry-After", String(result.retryAfterSeconds));
  res.write(
    `data: ${JSON.stringify({
      error: RATE_LIMITED_MESSAGE,
      code: "rate_limited",
      retryAfterSeconds: result.retryAfterSeconds,
    })}\n\n`
  );
  return res.end();
}

const LEAD_CLIENT_FIELDS = [
  "name",
  "email",
  "phone",
  "address_line1",
  "city",
  "state",
  "zip",
  "county",
  "source",
];

// ========== MAIN ENDPOINT ==========
router.post("/message", chatbotRateLimit, async (req, res) => {
  console.log("💬 New chatbot request:", req.body?.visitorId, req.body?.channel);

  try {
    const { channel = "web", input, lead } = req.body || {};
    const trimmedInput = String(input || "").trim();
    // A missing visitorId would match every stored conversation without one.
    const visitorId = typeof req.body?.visitorId === "string" ? req.body.visitorId.trim().slice(0, MAX_VISITOR_ID_CHARS) : "";
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (!trimmedInput) {
      send({ error: "Missing input" });
      return res.end();
    }
    if (!visitorId) {
      send({ error: "Missing visitor id" });
      return res.end();
    }
    if (trimmedInput.length > MAX_INPUT_CHARS) {
      send({
        error: `That message is too long. Please keep it under ${MAX_INPUT_CHARS} characters.`,
        code: "input_too_long",
      });
      return res.end();
    }

    // 1️⃣ Save lead if provided
    let leadDoc = null;
    if (lead && (lead.email || lead.phone)) {
      const identity = [
        lead.email ? { email: String(lead.email).trim().toLowerCase() } : null,
        lead.phone ? { phone: String(lead.phone).trim() } : null,
      ].filter(Boolean);
      const countyGuess = (lead.county || lead.city || "").toLowerCase();
      let detectedCounty = null;
      let status = "engaged";

      if (countyGuess.includes("nassau")) detectedCounty = "Nassau";
      if (countyGuess.includes("suffolk")) detectedCounty = "Suffolk";
      if (!detectedCounty) status = "waitlist";

      // Only contact fields the visitor can legitimately supply. Spreading the
      // raw body let a client set status, convertedAt, tags or follow-up stamps.
      const contactFields = {};
      for (const key of LEAD_CLIENT_FIELDS) {
        if (lead[key] == null) continue;
        contactFields[key] = String(lead[key]).trim().slice(0, 200);
      }

      leadDoc = await Lead.findOneAndUpdate(
        { $or: identity },
        {
          $set: {
            ...contactFields,
            county: detectedCounty || contactFields.county || null,
            status,
            channel,
            lastContactAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );
    }

    // 2️⃣ Load or create conversation
    let convo = await Conversation.findOne({ visitorId, channel });
    if (!convo) {
      convo = await Conversation.create({
        visitorId,
        channel,
        leadId: leadDoc?._id,
        messages: [{ role: "system", content: SYSTEM_PROMPT }],
        lastFollowupAt: null,
      });
    } else if (leadDoc && !convo.leadId) {
      convo.leadId = leadDoc._id;
    }



    // Route service requests or confirm callback intent before normal AI.
    const awaitingCallback = isAwaitingCallbackConfirmation(convo.messages);
    const alreadyNotified = hasCallbackNotification(convo.messages);
    const phone =
      leadDoc?.phone || extractPhoneNumber(trimmedInput) || phoneFromMessages(convo.messages);

    if (awaitingCallback && confirmsPhoneCall(trimmedInput)) {
      let reply;
      let meta = {};

      if (alreadyNotified) {
        reply =
          "I already sent your callback request to the Profixter team. If you are trying to book instead, use https://profixter.com/book.";
      } else if (!phone) {
        reply =
          "Yes, I can help with that. Please send the best phone number for the callback, then I can pass it to the Profixter team.";
        meta = { kind: "callback_confirmation_prompt" };
      } else {
        try {
          await sendAiCallbackAdminEmail({
            leadDoc,
            input: trimmedInput,
            channel,
            visitorId,
            phoneOverride: phone,
          });
          reply =
            "Confirmed. I sent your callback request to the Profixter team. If you were trying to book a visit, you can still use https://profixter.com/book any time.";
          meta = {
            kind: "callback_admin_notified",
            notifiedAt: new Date().toISOString(),
          };
        } catch (emailErr) {
          console.error("AI callback notification failed:", {
            leadId: leadDoc?._id,
            visitorId,
            message: emailErr.message,
          });
          reply =
            "I could not send the callback request right now. Please call Profixter directly at 631-599-1363, or use https://profixter.com/book to book online.";
        }
      }

      await saveAssistantBranch(convo, trimmedInput, reply, meta);
      return sendSseReply(res, reply);
    }

    if (awaitingCallback && declinesPhoneCall(trimmedInput)) {
      const reply = buildDeclinedCallbackReply();
      await saveAssistantBranch(convo, trimmedInput, reply);
      return sendSseReply(res, reply);
    }

    if (wantsPhoneCall(trimmedInput)) {
      const reply = buildCallbackConfirmationPrompt();
      await saveAssistantBranch(convo, trimmedInput, reply, {
        kind: "callback_confirmation_prompt",
      });
      return sendSseReply(res, reply);
    }

    const recommendation = getRoutingRecommendation(trimmedInput);
    if (shouldRouteToProductPage(trimmedInput, recommendation)) {
      const reply = buildRoutingReply(recommendation);
      await saveAssistantBranch(convo, trimmedInput, reply, {
        kind: "product_route",
        routeType: recommendation.type,
        routeUrl: recommendation.url,
      });
      return sendSseReply(res, reply);
    }

    convo.messages.push({ role: "user", content: trimmedInput });
    await convo.save();

    let replyText = "";
    send({ status: "typing" });

    /*
     * Stored system messages are left out: every conversation saved the prompt
     * of its day as its first message, and an old one would contradict the
     * current SYSTEM_PROMPT that answerQuestion always sends first. The last 20
     * turns are plenty for a support chat and keep the request small.
     */
    const history = convo.messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content }));

    replyText = await answerQuestion(history, (chunk) => send({ token: chunk }), trimmedInput);

    convo.messages.push({ role: "assistant", content: replyText });
    await convo.save();

    send({ done: true });
    res.end();
  } catch (err) {
    console.error("💥 Chatbot error:", err);
    res.write(`data: ${JSON.stringify({ error: "Chatbot failed" })}\n\n`);
    res.end();
  }
});

module.exports = router;
// Read by scripts/test_chatbot_lead_rules.js, which checks it never names a retired page.
module.exports.SYSTEM_PROMPT = SYSTEM_PROMPT;
module.exports.chatbotRateLimit = chatbotRateLimit;
module.exports.answerQuestion = answerQuestion;
module.exports.CHAT_LIMIT = CHAT_LIMIT;
module.exports.MAX_INPUT_CHARS = MAX_INPUT_CHARS;
