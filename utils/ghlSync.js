const RepAttribution = require("../models/RepAttribution");

const BASE_URL = "https://services.leadconnectorhq.com";

function cleanPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
  if (digits.length === 10) return "+1" + digits;
  return "+" + digits;
}

function getHeaders(locationId) {
  const token = process.env.GHL_API_TOKEN;

  if (!token) {
    throw new Error("Missing GHL_API_TOKEN in environment");
  }

  return {
    Authorization: `Bearer ${token}`,
    Version: "2021-07-28",
    Accept: "application/json",
    "Content-Type": "application/json",
    ...(locationId ? { LocationId: locationId } : {}),
  };
}

async function ghlFetch(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  const text = await res.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    throw new Error(
      `GHL ${options.method || "GET"} ${path} failed: ${res.status} ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function findContactInGhl({ match }) {
  const locationId = match.ghlLocationId || process.env.GHL_LOCATION_ID;
  const headers = getHeaders(locationId);

  const phone = cleanPhone(match.phoneRaw || match.phoneNormalized);
  const email = String(match.emailRaw || match.emailNormalized || "").trim().toLowerCase();

  if (phone) {
    try {
      const byPhone = await ghlFetch(
        `/contacts/search/duplicate?locationId=${encodeURIComponent(
          locationId
        )}&number=${encodeURIComponent(phone)}`,
        { method: "GET", headers }
      );

      if (byPhone?.contact?.id) {
        return byPhone.contact;
      }
    } catch (e) {
      console.warn("⚠️ GHL contact phone lookup failed:", e.message);
    }
  }

  if (email) {
    try {
      const byEmail = await ghlFetch(
        `/contacts/search/duplicate?locationId=${encodeURIComponent(
          locationId
        )}&email=${encodeURIComponent(email)}`,
        { method: "GET", headers }
      );

      if (byEmail?.contact?.id) {
        return byEmail.contact;
      }
    } catch (e) {
      console.warn("⚠️ GHL contact email lookup failed:", e.message);
    }
  }

  return null;
}

async function findPipelineStageIdByName({ locationId, pipelineName, stageName }) {
  const headers = getHeaders(locationId);

  const data = await ghlFetch(
    `/opportunities/pipelines?locationId=${encodeURIComponent(locationId)}`,
    { method: "GET", headers }
  );

  const pipelines = data?.pipelines || data?.data || [];
  const targetPipeline = pipelines.find(
    (p) =>
      String(p.name || "").trim().toLowerCase() ===
      String(pipelineName || "").trim().toLowerCase()
  );

  if (!targetPipeline) {
    throw new Error(`Pipeline not found by name: ${pipelineName}`);
  }

  const stages = targetPipeline.stages || [];
  const targetStage = stages.find(
    (s) =>
      String(s.name || "").trim().toLowerCase() ===
      String(stageName || "").trim().toLowerCase()
  );

  if (!targetStage) {
    throw new Error(`Stage not found by name: ${stageName}`);
  }

  return {
    pipelineId: targetPipeline.id,
    stageId: targetStage.id,
  };
}

async function findOpportunityForContact({ locationId, contactId, pipelineId }) {
  const headers = getHeaders(locationId);

  const data = await ghlFetch(
    `/opportunities/search?location_id=${encodeURIComponent(
      locationId
    )}&contact_id=${encodeURIComponent(contactId)}&pipeline_id=${encodeURIComponent(pipelineId)}`,
    { method: "GET", headers }
  );

  const opportunities = data?.opportunities || data?.data || data?.items || [];

  if (!Array.isArray(opportunities) || opportunities.length === 0) {
    return null;
  }

  const open = opportunities.find(
    (o) => !["won", "lost", "abandoned"].includes(String(o.status || "").toLowerCase())
  );

  return open || opportunities[0];
}

async function moveOpportunityStage({ locationId, opportunityId, pipelineId, stageId, status }) {
  const headers = getHeaders(locationId);

  const body = {
    pipelineId,
    pipelineStageId: stageId,
    status: status || "open",
  };

  return ghlFetch(`/opportunities/${encodeURIComponent(opportunityId)}`, {
    method: "PUT",
    headers,
    body: JSON.stringify(body),
  });
}

async function addContactNote({ locationId, contactId, body }) {
  const headers = getHeaders(locationId);

  return ghlFetch(`/contacts/${encodeURIComponent(contactId)}/notes`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body }),
  });
}

async function addContactTags({ locationId, contactId, tags }) {
  const headers = getHeaders(locationId);

  const cleanTags = Array.from(
    new Set(
      (Array.isArray(tags) ? tags : [])
        .map((t) => String(t || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );

  if (cleanTags.length === 0) return null;

  return ghlFetch(`/contacts/${encodeURIComponent(contactId)}/tags`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tags: cleanTags }),
  });
}

function buildNoteText({ match, event }) {
  if (event === "registered") {
    return `Customer registered on Profixter.com

Name: ${match.fullName || ""}
Email: ${match.emailRaw || ""}
Phone: ${match.phoneRaw || ""}
City: ${match.cityAtAssignment || ""}
State: ${match.stateAtAssignment || ""}
Registered At: ${match.registeredAt ? new Date(match.registeredAt).toISOString() : ""}`;
  }

  if (event === "subscribed") {
    return `Customer subscribed on Profixter.com

Name: ${match.fullName || ""}
Email: ${match.emailRaw || ""}
Phone: ${match.phoneRaw || ""}
Plan: ${match.subscriptionPlan || ""}
Billing: ${match.subscriptionBillingCycle || ""}
Value: $${Number(match.subscriptionValue || 0)}
Subscribed At: ${match.subscribedAt ? new Date(match.subscribedAt).toISOString() : ""}`;
  }

  return "";
}

function buildTags({ match, event }) {
  const tags = [];

  if (event === "registered") {
    tags.push("profixter_registered");
  }

  if (event === "subscribed") {
    tags.push("profixter_registered");
    tags.push("profixter_subscribed");

    if (match.subscriptionPlan) {
      tags.push(`profixter_plan_${String(match.subscriptionPlan).trim().toLowerCase()}`);
    }

    if (match.subscriptionBillingCycle) {
      tags.push(
        `profixter_billing_${String(match.subscriptionBillingCycle).trim().toLowerCase()}`
      );
    }
  }

  return tags;
}

async function syncGhlConversion({ repAttributionId, event }) {
  const match = await RepAttribution.findById(repAttributionId);
  if (!match) {
    console.log("ℹ️ syncGhlConversion: RepAttribution not found:", repAttributionId);
    return;
  }

  const locationId = match.ghlLocationId || process.env.GHL_LOCATION_ID;
  if (!locationId) {
    throw new Error("Missing ghlLocationId on match and no GHL_LOCATION_ID fallback in env");
  }

  let targetStageName = null;
  if (event === "registered") targetStageName = process.env.GHL_STAGE_REGISTERED;
  if (event === "subscribed") targetStageName = process.env.GHL_STAGE_SUBSCRIBED;

  if (!targetStageName) {
    throw new Error(`No target stage configured for event: ${event}`);
  }

  const pipelineName = process.env.GHL_PIPELINE_NAME;
  if (!pipelineName) {
    throw new Error("Missing GHL_PIPELINE_NAME in environment");
  }

  const { pipelineId, stageId } = await findPipelineStageIdByName({
    locationId,
    pipelineName,
    stageName: targetStageName,
  });

  let contactId = match.ghlContactId || null;
  if (!contactId) {
    const contact = await findContactInGhl({ match });
    if (!contact?.id) {
      throw new Error("Could not find GHL contact by phone/email");
    }
    contactId = contact.id;
    match.ghlContactId = contactId;
  }

  let opportunityId = match.ghlOpportunityId || null;
  if (!opportunityId) {
    const opp = await findOpportunityForContact({
      locationId,
      contactId,
      pipelineId,
    });

    if (!opp?.id) {
      throw new Error("Could not find GHL opportunity for contact");
    }

    opportunityId = opp.id;
    match.ghlOpportunityId = opportunityId;
  }

  await moveOpportunityStage({
    locationId,
    opportunityId,
    pipelineId,
    stageId,
    status: "open",
  });

  const noteText = buildNoteText({ match, event });
  if (noteText) {
    try {
      await addContactNote({
        locationId,
        contactId,
        body: noteText,
      });
    } catch (err) {
      console.warn("⚠️ Failed to create GHL note:", err.message);
    }
  }

  const tags = buildTags({ match, event });
  if (tags.length > 0) {
    try {
      await addContactTags({
        locationId,
        contactId,
        tags,
      });
    } catch (err) {
      console.warn("⚠️ Failed to add GHL tags:", err.message);
    }
  }

  match.ghlPipelineId = pipelineId;
  match.ghlStageId = stageId;
  match.lastSyncedAt = new Date();
  await match.save();

  console.log(`✅ GHL sync success for ${event}:`, {
    repAttributionId: String(match._id),
    contactId,
    opportunityId,
    pipelineId,
    stageId,
    tags,
  });
}

module.exports = {
  syncGhlConversion,
};