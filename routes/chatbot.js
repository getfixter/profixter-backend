// 📁 routes/chatbot.js
const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const Lead = require("../models/Lead");
const Conversation = require("../models/Conversation");
const knowledge = require("../data/chatbotKnowledge");
const { getNextAvailableSlot } = require("../utils/getNextAvailableSlot");
const {
  sendAdminLeadNotification,
} = require("../utils/adminLeadNotification");

// --- CONFIG ---
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const USE_STUB = !OPENAI_KEY;

const SYSTEM_PROMPT = `
You are the Profixter Assistant — a helpful, knowledgeable guide for Profixter, a Long Island home services company serving Nassau and Suffolk County, NY.

Profixter offers two paths:
1. HOME CARE MEMBERSHIP — monthly home maintenance subscription (same trusted team, peace of mind, handyman visits up to 90 min each).
2. HOME IMPROVEMENT PROJECTS — 1-Day Roof Replacement, Full Bathroom Remodeling, Full Kitchen Remodeling.

TONE: Warm, direct, and confident. Like a knowledgeable team member, not a generic chatbot. Short replies (2–4 sentences) unless the user asks for detail. No fluff.

NEVER SAY:
- “unlimited visits”
- “free trial”
- “cancel anytime” (say: active through current billing period after cancellation)
- “book every 3 days” or any specific booking frequency
- Any overpromise about service availability or pricing

ALWAYS:
- Use the knowledge base facts for accurate answers.
- For project pricing, direct to the free estimate: https://profixter.com/estimate
- For membership, direct to: https://profixter.com/membership
- For booking/scheduling questions from non-subscribers, direct to sign up first.
- If asked to cancel, confirm they are an active subscriber before sharing the cancellation phone number.
- Keep the Profixter brand name consistent — never say “Mr. Fixter.”
`;

const KNOWLEDGE_BLOCK = knowledge.toModelContext();

// ========== AI CALL (Streaming Support) ==========
async function callOpenAI(history, onChunk) {
  if (USE_STUB) {
    return `Got it! Profixter serves Nassau and Suffolk County, NY. You can explore membership plans at https://profixter.com/membership or get a free project estimate at https://profixter.com/estimate.`;
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

// ========== MAIN ENDPOINT ==========
router.post("/message", async (req, res) => {
  console.log("💬 New chatbot request:", req.body?.visitorId, req.body?.channel);

  try {
    const { visitorId, channel = "web", input, lead } = req.body;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    // 1️⃣ Save lead if provided
    let leadDoc = null;
    if (lead && (lead.email || lead.phone)) {
      const identity = [
        lead.email ? { email: String(lead.email).trim().toLowerCase() } : null,
        lead.phone ? { phone: String(lead.phone).trim() } : null,
      ].filter(Boolean);
      const existingLead = identity.length
        ? await Lead.findOne({ $or: identity }).lean()
        : null;
      const countyGuess = (lead.county || lead.city || "").toLowerCase();
      let detectedCounty = null;
      let status = "engaged";

      if (countyGuess.includes("nassau")) detectedCounty = "Nassau";
      if (countyGuess.includes("suffolk")) detectedCounty = "Suffolk";
      if (!detectedCounty) status = "waitlist";

      leadDoc = await Lead.findOneAndUpdate(
        { $or: identity },
        {
          $set: {
            ...lead,
            county: detectedCounty || lead.county || null,
            status,
            channel,
            lastContactAt: new Date(),
          },
        },
        { upsert: true, new: true }
      );

      if (!existingLead) {
        try {
          await sendAdminLeadNotification({
            leadId: String(leadDoc._id),
            leadType: "Chatbot Lead",
            service: "Chatbot inquiry",
            name: leadDoc.name,
            email: leadDoc.email,
            phone: leadDoc.phone,
            address: [
              leadDoc.address_line1,
              leadDoc.city,
              leadDoc.state,
              leadDoc.zip,
            ]
              .filter(Boolean)
              .join(", "),
            message: input,
            sourcePage: leadDoc.source || `chatbot:${channel}`,
            submittedAt: leadDoc.createdAt,
          });
        } catch (emailErr) {
          console.error("⚠️ Chatbot notification failed; lead was saved:", {
            leadId: leadDoc._id,
            message: emailErr.message,
          });
        }
      }
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



    // 4️⃣ Detect appointment-related question
    const appointmentRegex = /(available|appointment|book|schedule|slot|next time|next opening)/i;
    const isAppointmentQuery = appointmentRegex.test(input);

    const User = require("../models/User"); // ✅ add this near the top if not present

if (isAppointmentQuery) {
  const userDoc = leadDoc?.email
    ? await require("../models/User").findOne({ email: leadDoc.email })
    : null;

  const isSubscribed = userDoc?.subscription && userDoc.subscription !== "none";

  console.log("🧪 Appointment Query =", {
    input,
    email: leadDoc?.email,
    isSubscribed,
  });

  if (!isSubscribed) {
    send({
      token:
        "Once you subscribe, you can view and book the next available appointment 😊. Want to get started? 👉 https://profixter.com/register",
    });
    send({ done: true });
    return res.end();
  }

  const nextSlot = await getNextAvailableSlot();
  if (nextSlot) {
    const dateText = new Date(nextSlot).toLocaleString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
    send({
      token: `Our next available appointment is **${dateText}** 🗓️. You can book it here 👉 https://profixter.com`,
    });
  } else {
    send({
      token:
        "We’re currently fully booked for the next few weeks, but new slots open daily! Please check 👉 https://profixter.com",
    });
  }

  send({ done: true });
  return res.end();
}



    // 5️⃣ Append user message and proceed normally
    convo.messages.push({ role: "user", content: input });
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
