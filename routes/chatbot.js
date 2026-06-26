// 📁 routes/chatbot.js
const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const Lead = require("../models/Lead");
const Conversation = require("../models/Conversation");
const User = require("../models/User");
const knowledge = require("../data/chatbotKnowledge");
const { getNextAvailableSlot } = require("../utils/getNextAvailableSlot");
const {
  sendAdminLeadNotification,
} = require("../utils/adminLeadNotification");

// --- CONFIG ---
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const USE_STUB = !OPENAI_KEY;
const HOME_SUPPORT_MODEL = process.env.HOME_SUPPORT_AI_MODEL || "gpt-4o-mini";
const HOME_SUPPORT_RETENTION_DAYS = Math.max(
  1,
  Number(process.env.HOME_SUPPORT_AI_RETENTION_DAYS || 30)
);
const HOME_SUPPORT_MAX_TOTAL_UPLOAD_BYTES = 45 * 1024 * 1024;

const homeSupportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Math.max(
      1,
      Number(process.env.HOME_SUPPORT_AI_MAX_UPLOAD_MB || 15)
    ) * 1024 * 1024,
    files: 4,
  },
});

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

const HOME_SUPPORT_PROMPT = `
You are Profixter AI, the personal AI for home questions for Nassau and Suffolk County homeowners.

Positioning: "Our personal AI for all home questions." Help homeowners understand what is happening before they hire anyone.

Primary scope:
- Home maintenance, seasonal care, common home repairs, DIY planning, renovation planning, materials, tools, shopping lists, photos, PDFs, contractor quotes, contractor agreements, safety concerns, project research, and deciding whether to DIY or hire a professional.
- Stay focused on homes, contractors, repairs, renovation, maintenance, materials, tools, safety, and homeowner decisions.

Tone and structure:
- Sound human, calm, practical, and reassuring. Do not sound robotic.
- Give recommendations and options, not absolute commands.
- Be specific enough to help, but avoid pretending you can see or know more than the user provided.
- Ask concise follow-up questions when the situation is unclear.
- Prefer clear sections such as "What I notice", "What I would do next", "Materials/tools", "When to hire a pro", and "Safety note" when useful.

Off-topic handling:
- If the user asks something unrelated, random, or outside homeowner help, briefly acknowledge it and redirect back to home help.
- Do not answer general trivia, entertainment, politics, medical, finance, or unrelated personal questions unless they directly connect to home ownership or a home project.

Safety:
- For emergency danger, tell the user to contact 911, the utility company, or a licensed emergency provider as appropriate. Examples include active gas smell, sparking, fire risk, flooding, sewage backup, structural collapse risk, carbon monoxide concern, or shock risk.
- Refuse step-by-step instructions for dangerous electrical, plumbing, gas, structural, roofing, or hazardous work.
- You may recommend shutting off power, gas, or water only when it is safe to do so, keeping distance, documenting the issue, and contacting a licensed professional.
- Do not encourage the user to open energized electrical panels, work on live circuits, alter gas lines, perform major plumbing, disturb suspected asbestos/lead/mold, or make structural changes.

Contractor documents:
- For contractor agreements, estimates, quotes, scopes, or PDFs, explain that you can give a practical homeowner opinion and questions to ask, but not legal advice.
- Help identify unclear scope, missing exclusions, payment schedule concerns, material ambiguity, warranty questions, change-order language, permits, and red flags.

Profixter services:
- Book Handyman (/book): small scoped handyman tasks likely to fit a 90-minute visit.
- Membership (/membership): recurring maintenance, multiple ongoing small tasks, seasonal checkups, and peace-of-mind home care.
- Renovation Estimate (/projects): larger projects, roofing, full remodels, multi-day work, major electrical, plumbing remodels, structural work, or whole-room painting.
- Recommend these naturally only when they are actually relevant. Do not spam or force a sale.

Appliances:
- Profixter does not offer appliance repair.
- Never offer appliance repair or appliance troubleshooting as a Profixter service.
- If the user asks about an appliance, suggest checking the manual, manufacturer support, warranty support, or an appliance repair specialist. You may still help with non-repair homeowner context, such as measuring space for a renovation or planning cabinet layout around an appliance.
`;

function conversationExpiryDate() {
  return new Date(Date.now() + HOME_SUPPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

async function optionalUserFromRequest(req) {
  try {
    const bearer = req.header("Authorization");
    const token =
      (bearer && bearer.replace(/^Bearer\s+/i, "")) ||
      req.header("x-auth-token");
    if (!token) return null;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.id) return null;
    return User.findById(decoded.id).lean();
  } catch {
    return null;
  }
}

function attachmentKind(file) {
  const type = String(file?.mimetype || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  return "other";
}

function attachmentSummary(files = []) {
  return files.map((file) => ({
    filename: file.originalname,
    contentType: file.mimetype,
    size: file.size,
    kind: attachmentKind(file),
  }));
}

function outputTextFromResponse(data) {
  if (data?.output_text) return String(data.output_text);
  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.text) chunks.push(content.text);
      if (content?.type === "output_text" && content?.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}

async function callHomeSupportAI({ input, history, files }) {
  if (USE_STUB) {
    return "I can help think this through. I would start with safety, then separate what looks like DIY planning, a small 90-minute handyman task, ongoing maintenance, or a larger renovation. If you upload a photo, quote, agreement, or PDF when OpenAI is configured, I can review it more specifically.";
  }

  const content = [
    {
      type: "input_text",
      text: [
        "User question:",
        input,
        "",
        "Recent conversation:",
        history
          .slice(-8)
          .filter((message) => message.role !== "system")
          .map((message) => `${message.role}: ${message.content}`)
          .join("\n"),
      ].join("\n"),
    },
  ];

  for (const file of files || []) {
    const base64 = file.buffer.toString("base64");
    const kind = attachmentKind(file);
    if (kind === "image") {
      content.push({
        type: "input_image",
        image_url: `data:${file.mimetype};base64,${base64}`,
      });
    } else if (kind === "pdf") {
      content.push({
        type: "input_file",
        filename: file.originalname || "document.pdf",
        file_data: `data:application/pdf;base64,${base64}`,
      });
    }
  }

  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: HOME_SUPPORT_MODEL,
      instructions: `${HOME_SUPPORT_PROMPT}\n\n${KNOWLEDGE_BLOCK}`,
      input: [{ role: "user", content }],
      max_output_tokens: 900,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`OpenAI home support request failed: ${resp.status} ${text}`);
  }

  const data = await resp.json();
  return outputTextFromResponse(data) || "I had trouble reviewing that. Please try again with a little more detail.";
}

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

router.post(
  "/home-support/message",
  homeSupportUpload.array("files", 4),
  async (req, res) => {
    try {
      const { visitorId, input, channel = "home_support" } = req.body || {};
      const trimmedInput = String(input || "").trim();
      if (!visitorId || !trimmedInput) {
        return res.status(400).json({ message: "Missing visitorId or input" });
      }

      const files = req.files || [];
      const totalBytes = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
      if (totalBytes > HOME_SUPPORT_MAX_TOTAL_UPLOAD_BYTES) {
        return res.status(400).json({
          message: "Please upload less than 45 MB total across images and PDFs.",
        });
      }
      const unsupported = files.find(
        (file) => !["image", "pdf"].includes(attachmentKind(file))
      );
      if (unsupported) {
        return res.status(400).json({
          message: "Home Support AI accepts images and PDFs only.",
        });
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

      const authUser = await optionalUserFromRequest(req);
      const expiresAt = conversationExpiryDate();
      let convo = await Conversation.findOne({
        visitorId,
        channel,
        mode: "home_support",
      });
      if (!convo) {
        convo = await Conversation.create({
          visitorId,
          channel,
          mode: "home_support",
          user: authUser?._id || null,
          messages: [],
          attachments: [],
          lastMessageAt: new Date(),
          expiresAt,
        });
      } else {
        if (authUser?._id && !convo.user) convo.user = authUser._id;
        convo.expiresAt = expiresAt;
      }

      const attachments = attachmentSummary(files);
      convo.messages.push({
        role: "user",
        content: trimmedInput,
        meta: attachments.length ? { attachments } : undefined,
      });
      convo.attachments.push(...attachments);
      convo.lastMessageAt = new Date();
      await convo.save();

      send({ status: "typing" });
      const replyText = await callHomeSupportAI({
        input: trimmedInput,
        history: convo.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
        files,
      });

      convo.messages.push({ role: "assistant", content: replyText });
      convo.lastMessageAt = new Date();
      convo.expiresAt = expiresAt;
      await convo.save();

      send({ token: replyText });
      send({ done: true });
      return res.end();
    } catch (err) {
      console.error("Home Support AI error:", err);
      if (!res.headersSent) {
        return res.status(500).json({ message: "Home Support AI failed" });
      }
      res.write(`data: ${JSON.stringify({ error: "Home Support AI failed" })}\n\n`);
      return res.end();
    }
  }
);

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
