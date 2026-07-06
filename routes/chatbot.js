// 📁 routes/chatbot.js
const express = require("express");
const router = express.Router();
const fetch = require("node-fetch");
const multer = require("multer");
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
const HOME_SUPPORT_MODEL = process.env.HOME_SUPPORT_AI_MODEL || "gpt-4o-mini";
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

Profixter company knowledge:
- Profixter is a modern AI-powered home platform and local Long Island home service company based around four products: Profixter AI, Book Handyman, Membership, and Renovation.
- Profixter serves Long Island homeowners in Nassau and Suffolk Counties, with local Babylon roots. Profixter is licensed and insured. License: HI-71484.
- Profixter AI (/home-support): a free temporary AI assistant for home questions, photos, PDFs, contractor quotes, agreements, maintenance, repair planning, shopping lists, safety concerns, renovation research, and DIY-or-hire decisions.
- Book Handyman (/book): a $99 One-Time Visit for one predefined small handyman task, up to 90 minutes. Customers choose task, date/time, notes/photos, then pay. Admin approval happens after payment. Customers can book multiple One-Time Visits as long as each is paid separately and the selected slot is available.
- One-Time Visit examples include replacing a light fixture, replacing a faucet, patching a small hole, painting a door, TV mounting, caulking and sealing, shelves and mirrors, small furniture assembly, wall hangings, and small fixes.
- Membership (/membership): better for ongoing home maintenance, recurring small jobs, seasonal care, more service flexibility, priority scheduling or rush benefits depending on plan, and better long-term value than paying $99 each visit. Use "Membership", "Member", and "Become a Member"; avoid "subscription" in customer-facing wording.
- Members may receive discounts on larger projects. Some larger projects may qualify for up to 12 months of Membership.
- Renovation Estimate (/projects#estimate): for roofing, siding, kitchens, bathrooms, full house renovation, build new house, additions, multi-day work, major electrical/plumbing remodels, structural work, or anything larger than a One-Time Visit. Profixter acts as a General Contractor for larger projects.
- About Us (/about): use when someone wants the company story, trust, local background, founder story, or how Profixter works.
- Phone: 631-599-1363.
- Recommendations should feel like practical advice, not advertising. Recommend Book Handyman for one small repair, Membership for recurring jobs or ongoing maintenance, and Renovation Estimate for larger projects.
- If a user is trying to book, schedule, find availability, or make an appointment, navigate them to the proper page instead of treating it as a call lead: Book Handyman (/book), Membership (/membership), or Renovation Estimate (/projects#estimate).
- If a user asks for a phone call, verify first. Ask them to confirm with "Yes, call me" and provide the best phone number if needed. Do not imply the team has been notified until that confirmation is clear.

Appliances:
- Profixter does not offer appliance repair.
- Never offer appliance repair or appliance troubleshooting as a Profixter service.
- If the user asks about an appliance, suggest checking the manual, manufacturer support, warranty support, or an appliance repair specialist. You may still help with non-repair homeowner context, such as measuring space for a renovation or planning cabinet layout around an appliance.
`;

function parseHomeSupportHistory(raw) {
  try {
    const parsed = JSON.parse(String(raw || "[]"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((message) =>
        ["user", "assistant"].includes(String(message?.role || "")) &&
        String(message?.content || "").trim()
      )
      .slice(-8)
      .map((message) => ({
        role: String(message.role),
        content: String(message.content).trim().slice(0, 2000),
      }));
  } catch {
    return [];
  }
}

function attachmentKind(file) {
  const type = String(file?.mimetype || "").toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  return "other";
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

router.post(
  "/home-support/message",
  homeSupportUpload.array("files", 4),
  async (req, res) => {
    try {
      const { input, history: rawHistory } = req.body || {};
      const trimmedInput = String(input || "").trim();
      if (!trimmedInput) {
        return res.status(400).json({ message: "Missing input" });
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
      const history = parseHomeSupportHistory(rawHistory);
      const awaitingCallback = isAwaitingCallbackConfirmation(history);
      const phone = extractPhoneNumber(trimmedInput) || phoneFromMessages(history);

      if (awaitingCallback && confirmsPhoneCall(trimmedInput)) {
        if (!phone) {
          return sendSseReply(
            res,
            "Yes, I can help with that. Please send the best phone number for the callback, then I can pass it to the Profixter team."
          );
        }
        await sendAiCallbackAdminEmail({
          input: trimmedInput,
          sourcePage: "/home-support",
          phoneOverride: phone,
        });
        return sendSseReply(
          res,
          "Confirmed. I sent your callback request to the Profixter team. If you were trying to book a visit, you can still use https://profixter.com/book any time."
        );
      }

      if (awaitingCallback && declinesPhoneCall(trimmedInput)) {
        return sendSseReply(
          res,
          "No problem. If you are trying to book or request service, use the right page: Book Handyman https://profixter.com/book, Membership https://profixter.com/membership, or Renovation Estimate https://profixter.com/projects#estimate."
        );
      }

      if (wantsPhoneCall(trimmedInput)) {
        return sendSseReply(res, buildCallbackConfirmationPrompt());
      }

      const recommendation = getRoutingRecommendation(trimmedInput);
      if (shouldRouteToProductPage(trimmedInput, recommendation)) {
        return sendSseReply(res, buildRoutingReply(recommendation));
      }

      send({ status: "typing" });
      const replyText = await callHomeSupportAI({
        input: trimmedInput,
        history,
        files,
      });

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
