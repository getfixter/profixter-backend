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

// --- CONFIG ---
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const USE_STUB = !OPENAI_KEY;

const SYSTEM_PROMPT = `
You are the Profixter Assistant - a helpful, knowledgeable guide for Profixter, a modern AI-powered home platform and Long Island home services company serving Nassau and Suffolk County, NY.

Profixter has four customer products:
1. PROFIXTER AI - free home-focused AI guidance.
2. BOOK HANDYMAN - $99 One-Time Visits for predefined small handyman tasks, up to 90 minutes.
3. MEMBERSHIP - ongoing home support for Members who need recurring help and better long-term value.
4. RENOVATION - larger projects and estimates for roofing, siding, kitchens, bathrooms, full house renovation, build new house, additions, and other General Contractor work.

TONE: Warm, direct, and confident. Like a knowledgeable team member, not a generic chatbot. Short replies (2-4 sentences) unless the user asks for detail. No fluff.

NEVER SAY:
- "unlimited visits"
- "free trial"
- "cancel anytime" (say: active through current billing period after cancellation)
- "book every 3 days" or any specific booking frequency
- "Mr. Fixter"
- Any overpromise about service availability or pricing

ALWAYS:
- Use the knowledge base facts for accurate answers.
- Use customer-facing words Membership, Member, and Become a Member. Avoid "subscription" unless the user asks about billing mechanics.
- For one small predefined handyman task, direct to: https://profixter.com/book
- For membership, direct to: https://profixter.com/membership
- For larger projects, direct to the Renovation Estimate: https://profixter.com/projects#estimate
- If the user is trying to book, schedule, find availability, or make an appointment, route them to the correct page instead of collecting an admin lead.
- Only treat a phone call as an admin callback request after the user explicitly confirms they want a phone call. If they are just trying to book, send them to the booking page.
- If asked to cancel, confirm they are an active Member before sharing the cancellation phone number.
- Never offer appliance repair as a Profixter service.
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
async function callOpenAI(history, onChunk) {
  if (USE_STUB) {
    return `Got it! Profixter serves Nassau and Suffolk County, NY. You can explore Membership at https://profixter.com/membership or request a Renovation Estimate at https://profixter.com/projects#estimate.`;
  }

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "system", content: KNOWLEDGE_BLOCK },
        ...history,
      ],
      temperature: 0.7,
      max_tokens: 200,
      stream: true,
    }),
  });

  let fullText = "";
  for await (const chunk of resp.body) {
    const decoded = new TextDecoder().decode(chunk);
    const lines = decoded.split("\n").filter(Boolean);
    for (const line of lines) {
      if (line.includes("[DONE]")) continue;
      try {
        const json = JSON.parse(line.replace(/^data:\s*/, ""));
        const token = json?.choices?.[0]?.delta?.content;
        if (token) {
          fullText += token;
          if (onChunk) onChunk(token);
        }
      } catch {
        // skip malformed
      }
    }
  }
  return fullText.trim() || "Sorry, I had trouble replying.";
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
router.post("/message", async (req, res) => {
  console.log("💬 New chatbot request:", req.body?.visitorId, req.body?.channel);

  try {
    const { visitorId, channel = "web", input, lead } = req.body;
    const trimmedInput = String(input || "").trim();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (!trimmedInput) {
      send({ error: "Missing input" });
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
      const reply =
        "No problem. If you are trying to book or request service, use the right page: Book Handyman https://profixter.com/book, Membership https://profixter.com/membership, or Renovation Estimate https://profixter.com/projects#estimate.";
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

    const history = convo.messages.map((m) => ({ role: m.role, content: m.content }));

    replyText = await callOpenAI(history, (chunk) => send({ token: chunk }));

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
