const { findEndpoint } = require("./ghlEndpointRegistry");

function cleanString(value) {
  return String(value ?? "").trim();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function formatMoney(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number <= 0) return "";
  return number.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}

function firstNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function moduleByKey(modules = []) {
  return asArray(modules).reduce((map, module) => {
    if (module?.key) map.set(module.key, module);
    return map;
  }, new Map());
}

function moduleTotal(module, ...keys) {
  const data = module?.data || {};
  const stats = module?.stats || {};
  return firstNumber(
    ...keys.map((key) => data[key]),
    stats.total,
    stats.returned,
    data.total,
    data.returned
  );
}

function topEntries(value = {}, limit = 3) {
  return Object.entries(value || {})
    .map(([name, count]) => ({ name, count: Number(count || 0) }))
    .filter((item) => item.name && item.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

function tagNames(tagsModule) {
  return asArray(tagsModule?.data?.tags)
    .map((tag) => cleanString(tag?.name || tag?.tag || tag?.label))
    .filter(Boolean);
}

function addUnique(list, value) {
  const clean = cleanString(value);
  if (clean && !list.includes(clean)) list.push(clean);
}

function registryStatus(endpoint) {
  if (!endpoint?.method || !endpoint?.path) return { registered: false, label: "not checked" };
  const found = findEndpoint({ method: endpoint.method, path: endpoint.path });
  if (!found?.endpoint) return { registered: false, label: "not in registry" };
  if (found.endpoint.enabled === false || found.endpoint.deprecated === true) {
    return { registered: true, label: "registered but disabled/deprecated" };
  }
  return { registered: true, label: "registered and enabled" };
}

function endpointLabel(endpoint) {
  return `${cleanString(endpoint.method || "GET").toUpperCase()} ${cleanString(endpoint.path)}`;
}

function moduleReason(module) {
  if (!module) return "this audit did not run a module for it";
  if (module.status !== "completed") {
    return `Jarvis tried it and the module failed with ${module.error?.reason || module.error?.type || "module_failed"}`;
  }
  return "Jarvis used it in this audit";
}

function requirement({ name, endpoints = [], module, available, missingFields = [], limitation = "" }, byKey) {
  const endpointDetails = endpoints.map((endpoint) => ({
    ...endpoint,
    label: endpointLabel(endpoint),
    registry: registryStatus(endpoint),
  }));
  const auditModule = module ? byKey.get(module) : null;
  const registered = endpointDetails.length
    ? endpointDetails.every((endpoint) => endpoint.registry.registered)
    : false;
  const used = Boolean(auditModule && auditModule.status === "completed");
  let status = "available";

  if (limitation) {
    status = `GHL/API limitation: ${limitation}`;
  } else if (!endpointDetails.length) {
    status = "missing endpoint definition";
  } else if (!registered) {
    status = "endpoint support missing in our registry";
  } else if (!auditModule) {
    status = "endpoint exists, but this audit did not call it";
  } else if (auditModule.status !== "completed") {
    status = moduleReason(auditModule);
  } else if (available !== true) {
    status = missingFields.length
      ? `endpoint used, but GHL did not return required field(s): ${missingFields.join(", ")}`
      : "endpoint used, but the returned data was not enough for this calculation";
  }

  return {
    name,
    endpoints: endpointDetails,
    module,
    registered,
    used,
    available: available === true,
    missingFields,
    limitation,
    status,
  };
}

function formatRequirement(item) {
  const endpoints = item.endpoints?.length
    ? item.endpoints.map((endpoint) => `${endpoint.label} (${endpoint.registry.label})`).join("; ")
    : "No supported endpoint identified";
  return `- ${item.name}: ${item.status}. Required endpoint(s): ${endpoints}.`;
}

function endpointUsedText(module) {
  const endpoint = cleanString(module?.data?.endpointUsed);
  return endpoint || "endpoint used by module";
}

function buildRequirementMap({ byKey, values, healthReport }) {
  const contacts = byKey.get("contacts");
  const opportunities = byKey.get("opportunities");
  const conversations = byKey.get("conversations");
  const tasks = byKey.get("tasks");
  const tags = byKey.get("tags");
  const campaigns = byKey.get("campaigns");
  const workflows = byKey.get("workflows");
  const users = byKey.get("users");
  const calendars = byKey.get("calendars");
  const pipelines = byKey.get("pipelines");

  const oppEndpoint = { method: "GET", path: "/opportunities/search" };
  const contactEndpoint = { method: "POST", path: "/contacts/search" };
  const conversationEndpoint = { method: "GET", path: "/conversations/search" };
  const conversationMessagesEndpoint = { method: "GET", path: "/conversations/:conversationId/messages" };
  const taskEndpoint = { method: "POST", path: "/locations/:locationId/tasks/search" };
  const tagEndpoint = { method: "GET", path: "/locations/:locationId/tags" };
  const campaignEndpoint = { method: "GET", path: "/campaigns/" };
  const workflowEndpoint = { method: "GET", path: "/workflows/" };
  const userEndpoint = { method: "GET", path: "/users/search" };
  const calendarEndpoint = { method: "GET", path: "/calendars/" };
  const pipelineEndpoint = { method: "GET", path: "/opportunities/pipelines" };

  const healthCapabilityData =
    healthReport && asArray(healthReport?.capabilities?.working || healthReport?.working).length +
      asArray(healthReport?.capabilities?.failing || healthReport?.failing).length > 0;

  return {
    criticalProblems: [
      requirement({
        name: "Unread/open conversations",
        endpoints: [conversationEndpoint],
        module: "conversations",
        available: Number.isFinite(values.conversationWaiting),
        missingFields: ["unreadCount/status/state"],
      }, byKey),
      requirement({
        name: "Stale opportunities",
        endpoints: [oppEndpoint],
        module: "opportunities",
        available: values.activityAvailable,
        missingFields: ["lastActivityAt/updatedAt/dateUpdated"],
      }, byKey),
      requirement({
        name: "Open and overdue tasks",
        endpoints: [taskEndpoint],
        module: "tasks",
        available: Number.isFinite(values.taskOpen) || Number.isFinite(values.taskOverdue),
        missingFields: ["status/dueDate/assignedTo"],
      }, byKey),
      requirement({
        name: "GHL capability failures",
        endpoints: [],
        module: "",
        available: healthCapabilityData || !healthReport,
        limitation: healthReport ? "" : "Health-check capability details come from Jarvis control-center diagnostics, not a single GHL object endpoint.",
      }, byKey),
    ],
    revenueOpportunities: [
      requirement({
        name: "Opportunity value and stage",
        endpoints: [oppEndpoint, pipelineEndpoint],
        module: "opportunities",
        available: values.valueAvailable && Number.isFinite(values.opportunityTotal),
        missingFields: ["monetaryValue/value/amount", "pipelineStageId"],
      }, byKey),
      requirement({
        name: "Audience size and segmentation",
        endpoints: [contactEndpoint, tagEndpoint],
        module: "contacts",
        available: Number.isFinite(values.contactsTotal) && tags?.status === "completed",
        missingFields: ["contacts.total", "tags"],
      }, byKey),
      requirement({
        name: "Campaign inventory",
        endpoints: [campaignEndpoint],
        module: "campaigns",
        available: campaigns?.status === "completed",
        missingFields: ["campaign status/performance fields"],
      }, byKey),
    ],
    aiAutomationOpportunities: [
      requirement({
        name: "Workflow inventory",
        endpoints: [workflowEndpoint],
        module: "workflows",
        available: workflows?.status === "completed",
        missingFields: ["workflow id/name/status"],
      }, byKey),
      requirement({
        name: "Workflow internals and performance",
        endpoints: [workflowEndpoint],
        module: "workflows",
        available: false,
        limitation: "the current official workflow list endpoint used by this audit is useful for inventory, but this codebase does not have a confirmed supported endpoint for workflow trigger logic, step rules, conversion metrics, or failure rates.",
      }, byKey),
      requirement({
        name: "Automation trigger candidates",
        endpoints: [conversationEndpoint, oppEndpoint, taskEndpoint],
        module: "conversations",
        available: Number.isFinite(values.conversationWaiting) || values.activityAvailable || Number.isFinite(values.taskOpen),
        missingFields: ["conversation status", "opportunity activity date", "task status/dueDate"],
      }, byKey),
    ],
    salesOpportunities: [
      requirement({
        name: "Pipeline and stage distribution",
        endpoints: [oppEndpoint, pipelineEndpoint],
        module: "opportunities",
        available: Number.isFinite(values.opportunityTotal) && pipelines?.status === "completed",
        missingFields: ["pipelineId", "pipelineStageId"],
      }, byKey),
      requirement({
        name: "Opportunity owner assignment",
        endpoints: [oppEndpoint, userEndpoint],
        module: "opportunities",
        available: values.ownerAvailable,
        missingFields: ["assignedTo/userId/ownerId"],
      }, byKey),
      requirement({
        name: "Sales tasks",
        endpoints: [taskEndpoint],
        module: "tasks",
        available: tasks?.status === "completed",
        missingFields: ["task status/dueDate/assignedTo"],
      }, byKey),
    ],
    marketingOpportunities: [
      requirement({
        name: "Service-interest tags",
        endpoints: [tagEndpoint],
        module: "tags",
        available: tags?.status === "completed",
        missingFields: ["tag names"],
      }, byKey),
      requirement({
        name: "Campaign list",
        endpoints: [campaignEndpoint],
        module: "campaigns",
        available: campaigns?.status === "completed",
        missingFields: ["campaign list"],
      }, byKey),
      requirement({
        name: "Campaign performance",
        endpoints: [campaignEndpoint],
        module: "campaigns",
        available: false,
        limitation: "the campaign list endpoint confirms campaign inventory, but this codebase does not have a confirmed supported endpoint for sends/replies/appointments/revenue attribution by campaign.",
      }, byKey),
    ],
    teamPerformance: [
      requirement({
        name: "Users/team members",
        endpoints: [userEndpoint],
        module: "users",
        available: users?.status === "completed",
        missingFields: ["user id/name/email"],
      }, byKey),
      requirement({
        name: "Task ownership and overdue work",
        endpoints: [taskEndpoint],
        module: "tasks",
        available: tasks?.status === "completed",
        missingFields: ["assignedTo/status/dueDate"],
      }, byKey),
      requirement({
        name: "Appointment load",
        endpoints: [calendarEndpoint],
        module: "calendars",
        available: calendars?.status === "completed",
        missingFields: ["calendar/event records"],
      }, byKey),
      requirement({
        name: "Response time by user",
        endpoints: [conversationEndpoint, conversationMessagesEndpoint, userEndpoint],
        module: "conversation_messages",
        available: false,
        limitation: "conversation search gives the queue; message-level response time requires per-conversation reads from /conversations/:conversationId/messages. The endpoint is now in the registry, but this broad audit does not fan out across every conversation yet.",
      }, byKey),
    ],
    todaysPriorityTasks: [
      requirement({
        name: "Waiting conversations",
        endpoints: [conversationEndpoint],
        module: "conversations",
        available: Number.isFinite(values.conversationWaiting),
        missingFields: ["unreadCount/status/state"],
      }, byKey),
      requirement({
        name: "Overdue tasks",
        endpoints: [taskEndpoint],
        module: "tasks",
        available: tasks?.status === "completed",
        missingFields: ["status/dueDate"],
      }, byKey),
      requirement({
        name: "Stale open opportunities",
        endpoints: [oppEndpoint],
        module: "opportunities",
        available: values.activityAvailable,
        missingFields: ["status", "lastActivityAt/updatedAt/dateUpdated"],
      }, byKey),
    ],
    estimatedRevenueImpact: [
      requirement({
        name: "Opportunity dollar value",
        endpoints: [oppEndpoint],
        module: "opportunities",
        available: values.valueAvailable,
        missingFields: ["monetaryValue/value/amount"],
      }, byKey),
      requirement({
        name: "Campaign revenue attribution",
        endpoints: [campaignEndpoint],
        module: "campaigns",
        available: false,
        limitation: "the campaign inventory endpoint does not give this advisor confirmed revenue attribution by campaign.",
      }, byKey),
    ],
    recommendedNextActions: [
      requirement({
        name: "Action queue",
        endpoints: [conversationEndpoint, taskEndpoint, oppEndpoint],
        module: "tasks",
        available: Number.isFinite(values.conversationWaiting) || tasks?.status === "completed" || values.activityAvailable,
        missingFields: ["conversation status", "task due date", "opportunity activity date"],
      }, byKey),
    ],
  };
}

function availableRequirements(requirements = []) {
  return requirements.filter((item) => item.available === true);
}

function limitedRequirements(requirements = []) {
  return requirements.filter((item) => item.available !== true);
}

function dataUsed(requirements = []) {
  const used = availableRequirements(requirements)
    .map((item) => {
      const endpointText = item.endpoints?.map((endpoint) => endpoint.label).join("; ");
      return `${item.name} from ${endpointText || "Jarvis diagnostic data"}`;
    });
  return used.length ? used : ["No complete data source for this section returned enough fields."];
}

function buildBusinessAdvisorReport({
  action = "",
  label = "GHL Audit",
  modules = [],
  warnings = [],
  healthReport = null,
} = {}) {
  const byKey = moduleByKey(modules);
  const contacts = byKey.get("contacts");
  const tags = byKey.get("tags");
  const pipelines = byKey.get("pipelines");
  const opportunities = byKey.get("opportunities");
  const conversations = byKey.get("conversations");
  const workflows = byKey.get("workflows");
  const campaigns = byKey.get("campaigns");
  const users = byKey.get("users");
  const calendars = byKey.get("calendars");
  const tasks = byKey.get("tasks");

  const failedModules = asArray(modules).filter((module) => module.status !== "completed");
  const contactsTotal = moduleTotal(contacts, "total", "scanned");
  const tagTotal = moduleTotal(tags, "total");
  const pipelineTotal = firstNumber(pipelines?.data?.totalPipelines, moduleTotal(pipelines, "total"));
  const stageTotal = firstNumber(pipelines?.data?.totalStages);
  const opportunityTotal = moduleTotal(opportunities, "total", "counted");
  const conversationWaiting = firstNumber(conversations?.data?.waiting);
  const workflowTotal = moduleTotal(workflows, "total");
  const campaignTotal = moduleTotal(campaigns, "total");
  const userTotal = moduleTotal(users, "total");
  const calendarTotal = moduleTotal(calendars, "total");
  const taskTotal = moduleTotal(tasks, "total");
  const taskOpen = firstNumber(tasks?.data?.open);
  const taskOverdue = firstNumber(tasks?.data?.overdue);
  const taskCompleted = firstNumber(tasks?.data?.completed);
  const oppSignals = opportunities?.data?.businessSignals || {};
  const stale30 = firstNumber(oppSignals.stale30Days);
  const stale60 = firstNumber(oppSignals.stale60Days);
  const openOpps = firstNumber(oppSignals.openCount);
  const valueTotal = firstNumber(oppSignals.valueTotal);
  const staleValue = firstNumber(oppSignals.staleValue);
  const missingValueCount = firstNumber(oppSignals.missingValueCount);
  const missingActivityDateCount = firstNumber(oppSignals.missingActivityDateCount);
  const assignedCount = firstNumber(oppSignals.assignedCount);
  const unassignedCount = firstNumber(oppSignals.unassignedCount);
  const scannedOpps = firstNumber(oppSignals.scanned);
  const valueAvailable = oppSignals.valueAvailable === true;
  const activityAvailable = scannedOpps !== null && missingActivityDateCount !== null && missingActivityDateCount < scannedOpps;
  const ownerAvailable = assignedCount !== null && assignedCount > 0;
  const stageHotspots = topEntries(opportunities?.data?.byStage, 4);
  const pipelineHotspots = topEntries(opportunities?.data?.byPipeline, 3);
  const taskOwnerHotspots = topEntries(tasks?.data?.byOwner, 3);
  const names = tagNames(tags);
  const hasRoofingAudience = names.some((name) => /roof|siding|estimate/i.test(name));
  const failingCapabilities = asArray(healthReport?.capabilities?.failing || healthReport?.failing);
  const failedRecentActions = asArray(healthReport?.failedActions);

  const values = {
    contactsTotal,
    opportunityTotal,
    conversationWaiting,
    taskOpen,
    taskOverdue,
    valueAvailable,
    activityAvailable,
    ownerAvailable,
  };
  const sectionDataRequirements = buildRequirementMap({ byKey, values, healthReport });

  const criticalProblems = [];
  const revenueOpportunities = [];
  const aiAutomationOpportunities = [];
  const salesOpportunities = [];
  const marketingOpportunities = [];
  const teamPerformance = [];
  const todaysPriorityTasks = [];
  const estimatedRevenueImpact = [];
  const recommendedNextActions = [];

  if (failedModules.length) {
    addUnique(
      criticalProblems,
      `${formatNumber(failedModules.length)} audit module${failedModules.length === 1 ? "" : "s"} failed: ${failedModules.map((module) => `${module.label} (${module.error?.reason || module.error?.type || "module_failed"})`).join(", ")}. These are data-access problems, not business conclusions.`
    );
  }
  if (failingCapabilities.length) {
    addUnique(
      criticalProblems,
      `${formatNumber(failingCapabilities.length)} GHL capability check${failingCapabilities.length === 1 ? "" : "s"} failed in the health check. Jarvis uses those failures as data gaps instead of making assumptions.`
    );
  }
  if (failedRecentActions.length) {
    addUnique(
      criticalProblems,
      `${formatNumber(failedRecentActions.length)} recent universal GHL action${failedRecentActions.length === 1 ? "" : "s"} failed or were rejected. Review the audit log before expanding automation.`
    );
  }
  if (conversationWaiting && conversationWaiting > 0) {
    addUnique(
      criticalProblems,
      `${formatNumber(conversationWaiting)} conversations are open, unread, or waiting in GHL. This is real follow-up risk from the conversation search data.`
    );
  }
  if (stale30 && stale30 > 0) {
    addUnique(
      criticalProblems,
      `${formatNumber(stale30)} opportunities have had no visible activity for over 30 days in the returned GHL opportunity data.`
    );
  }
  if (stale60 && stale60 > 0) {
    addUnique(
      criticalProblems,
      `${formatNumber(stale60)} opportunities appear stalled for over 60 days. Treat these as save-or-close decisions.`
    );
  }
  if (taskOverdue && taskOverdue > 0) {
    addUnique(
      criticalProblems,
      `${formatNumber(taskOverdue)} tasks are overdue in the returned GHL task data.`
    );
  }
  if (contacts?.data?.partial === true) {
    addUnique(
      criticalProblems,
      `Contact count is partial. Jarvis used ${endpointUsedText(contacts)}, but GHL did not return an exact total before the safe scan limit.`
    );
  }
  if (pipelineTotal === 0 || stageTotal === 0) {
    addUnique(
      criticalProblems,
      "Pipeline/stage data returned empty or unreadable from the pipeline endpoint, so sales stage health cannot be trusted yet."
    );
  }

  if (contactsTotal && contactsTotal > 0) {
    addUnique(
      revenueOpportunities,
      `${formatNumber(contactsTotal)} contacts are available for real segmentation once tags/source/stage fields are present in the contact data.`
    );
  }
  if (openOpps && openOpps > 0) {
    addUnique(
      revenueOpportunities,
      `${formatNumber(openOpps)} open opportunities are visible in GHL. Prioritize open deals with value, stale activity, or late-stage placement.`
    );
  } else if (opportunityTotal && opportunityTotal > 0) {
    addUnique(
      revenueOpportunities,
      `${formatNumber(opportunityTotal)} opportunities are visible in GHL. Ranking depends on returned value, stage, owner, and activity fields.`
    );
  }
  if (staleValue && staleValue > 0) {
    addUnique(
      revenueOpportunities,
      `${formatMoney(staleValue)} in stale opportunity value is visible in the scanned opportunity set.`
    );
  }
  if (missingValueCount && missingValueCount > 0) {
    addUnique(
      revenueOpportunities,
      `${formatNumber(missingValueCount)} opportunities did not include a usable value field in the returned GHL data, so revenue ranking is incomplete for those records.`
    );
  }

  if (conversationWaiting && conversationWaiting > 0) {
    addUnique(
      aiAutomationOpportunities,
      `Use AI triage on the ${formatNumber(conversationWaiting)} waiting conversation${conversationWaiting === 1 ? "" : "s"}: classify intent, draft reply, tag urgency, and notify the owner.`
    );
  }
  if (stale30 && stale30 > 0) {
    addUnique(
      aiAutomationOpportunities,
      `Create a stale-opportunity workflow for the ${formatNumber(stale30)} stale opportunit${stale30 === 1 ? "y" : "ies"} Jarvis found.`
    );
  }
  if (taskOpen && taskOpen > 0) {
    addUnique(
      aiAutomationOpportunities,
      `Use task automation around the ${formatNumber(taskOpen)} open task${taskOpen === 1 ? "" : "s"}: overdue alerts, owner reminders, and stale-deal task creation.`
    );
  }
  if (workflowTotal && workflowTotal > 0) {
    addUnique(
      aiAutomationOpportunities,
      `${formatNumber(workflowTotal)} workflows are visible. Jarvis can inventory them, but trigger/step performance requires workflow internals that are not confirmed in this codebase.`
    );
  }

  if (stageHotspots.length) {
    addUnique(
      salesOpportunities,
      `Pipeline concentration from GHL: ${stageHotspots.map((item) => `${item.name} has ${formatNumber(item.count)}`).join("; ")}. Use these stages for today's call list.`
    );
  }
  if (pipelineHotspots.length) {
    addUnique(
      salesOpportunities,
      `Highest-volume pipelines from GHL: ${pipelineHotspots.map((item) => `${item.name} (${formatNumber(item.count)})`).join(", ")}.`
    );
  }
  if (assignedCount !== null || unassignedCount !== null) {
    addUnique(
      salesOpportunities,
      `${formatNumber(assignedCount || 0)} opportunities have owner data and ${formatNumber(unassignedCount || 0)} are missing owner data in the returned set.`
    );
  }

  if (hasRoofingAudience) {
    addUnique(
      marketingOpportunities,
      "Roofing/siding/estimate tags exist in GHL. Use those real tags for focused re-engagement instead of a broad blast."
    );
  }
  if (tagTotal && tagTotal > 0) {
    addUnique(
      marketingOpportunities,
      `${formatNumber(tagTotal)} tags are visible in GHL. Campaign segmentation should be based on those actual tag names.`
    );
  }
  if (campaignTotal && campaignTotal > 0) {
    addUnique(
      marketingOpportunities,
      `${formatNumber(campaignTotal)} campaigns are visible in GHL. Campaign performance is a separate data gap unless GHL returns sends/replies/appointment attribution.`
    );
  } else if (campaigns?.status !== "completed") {
    addUnique(
      marketingOpportunities,
      `Campaign analysis is blocked by the campaigns module status: ${campaigns?.error?.reason || campaigns?.error?.type || "module_not_completed"}.`
    );
  }

  if (userTotal && userTotal > 0) {
    addUnique(
      teamPerformance,
      `${formatNumber(userTotal)} team member${userTotal === 1 ? "" : "s"} are visible in GHL. Combine users with tasks, opportunity owners, conversations, and appointments for owner-level accountability.`
    );
  }
  if (taskTotal && taskTotal > 0) {
    addUnique(
      teamPerformance,
      `${formatNumber(taskTotal)} tasks are visible: ${formatNumber(taskOpen || 0)} open, ${formatNumber(taskCompleted || 0)} completed, ${formatNumber(taskOverdue || 0)} overdue.`
    );
  }
  if (taskOwnerHotspots.length) {
    addUnique(
      teamPerformance,
      `Task load by owner from GHL: ${taskOwnerHotspots.map((item) => `${item.name} (${formatNumber(item.count)})`).join(", ")}.`
    );
  }
  if (calendarTotal && calendarTotal > 0) {
    addUnique(
      teamPerformance,
      `${formatNumber(calendarTotal)} calendar${calendarTotal === 1 ? "" : "s"} are visible. Appointment volume can be compared against open opportunities when event data is available.`
    );
  }

  if (conversationWaiting && conversationWaiting > 0) {
    addUnique(
      todaysPriorityTasks,
      `Clear the ${formatNumber(conversationWaiting)} waiting conversation${conversationWaiting === 1 ? "" : "s"} first.`
    );
  }
  if (taskOverdue && taskOverdue > 0) {
    addUnique(
      todaysPriorityTasks,
      `Resolve or reassign the ${formatNumber(taskOverdue)} overdue task${taskOverdue === 1 ? "" : "s"}.`
    );
  }
  if (stale30 && stale30 > 0) {
    addUnique(
      todaysPriorityTasks,
      `Assign same-day follow-up for the oldest ${formatNumber(Math.min(stale30, 25))} stale opportunit${Math.min(stale30, 25) === 1 ? "y" : "ies"}.`
    );
  }

  if (valueTotal && valueTotal > 0) {
    addUnique(
      estimatedRevenueImpact,
      `${formatMoney(valueTotal)} in opportunity value was returned by GHL in the scanned set.`
    );
    if (staleValue && staleValue > 0) {
      addUnique(
        estimatedRevenueImpact,
        `${formatMoney(staleValue)} of that value is tied to opportunities with no visible activity for over 30 days.`
      );
    }
  }
  if (!valueAvailable) {
    addUnique(
      estimatedRevenueImpact,
      "Revenue impact needs opportunity value fields from GHL. Required fields: monetaryValue, value, amount, opportunityValue, estimatedValue, price, or dealValue."
    );
  }
  if (conversationWaiting && conversationWaiting > 0) {
    addUnique(
      estimatedRevenueImpact,
      `${formatNumber(conversationWaiting)} waiting conversation${conversationWaiting === 1 ? "" : "s"} are near-term revenue risk, but dollar impact needs lead/opportunity value linkage.`
    );
  }

  addUnique(
    recommendedNextActions,
    "Use the real action queue in this order: waiting conversations, overdue tasks, stale opportunities, then campaign/audience cleanup."
  );
  if (failedModules.length || failingCapabilities.length) {
    addUnique(
      recommendedNextActions,
      "Fix failed modules first because Jarvis is marking those as data gaps, not business findings."
    );
  }
  if (missingValueCount && missingValueCount > 0) {
    addUnique(
      recommendedNextActions,
      "Add values to opportunities missing dollar data so Jarvis can rank revenue impact from your actual pipeline."
    );
  }
  if (contactsTotal && contactsTotal > 0 && tagTotal && tagTotal > 0) {
    addUnique(
      recommendedNextActions,
      "Build one segmented audience from actual contact/tag data before launching any campaign."
    );
  }

  const sections = {
    criticalProblems,
    revenueOpportunities,
    aiAutomationOpportunities,
    salesOpportunities,
    marketingOpportunities,
    teamPerformance,
    todaysPriorityTasks,
    estimatedRevenueImpact,
    recommendedNextActions,
  };

  for (const [key, list] of Object.entries(sections)) {
    if (!list.length) {
      const limited = limitedRequirements(sectionDataRequirements[key] || []);
      list.push(
        limited.length
          ? `No account-specific finding for this section yet. The missing data is listed below, including the exact endpoint and reason.`
          : `No issue or opportunity surfaced from the completed GHL data for this section.`
      );
    }
  }

  const firstThreeActions = [
    todaysPriorityTasks[0],
    salesOpportunities[0],
    recommendedNextActions[0],
  ].filter(Boolean).slice(0, 3);

  while (firstThreeActions.length < 3) {
    const limited = limitedRequirements(sectionDataRequirements.recommendedNextActions || []);
    firstThreeActions.push(
      limited[firstThreeActions.length]?.name
        ? `Unlock ${limited[firstThreeActions.length].name}: ${limited[firstThreeActions.length].status}.`
        : "Run the account audit again after the missing GHL data above is available."
    );
  }

  return {
    action,
    title: `${label} Business Operations Analysis`,
    ...sections,
    firstThreeActions,
    sectionDataRequirements,
    recommendationDataMap: sectionDataRequirements,
    warnings,
  };
}

const SECTION_LABELS = {
  criticalProblems: "Critical Problems",
  revenueOpportunities: "Revenue Opportunities",
  aiAutomationOpportunities: "AI Automation Opportunities",
  salesOpportunities: "Sales Opportunities",
  marketingOpportunities: "Marketing Opportunities",
  teamPerformance: "Team Performance",
  todaysPriorityTasks: "Today's Priority Tasks",
  estimatedRevenueImpact: "Estimated Revenue Impact",
  recommendedNextActions: "Recommended Next Actions",
};

function formatSection(report, key) {
  const items = asArray(report[key]);
  const requirements = asArray(report.sectionDataRequirements?.[key]);
  const used = dataUsed(requirements);
  const limited = limitedRequirements(requirements);
  return [
    `${SECTION_LABELS[key]}:`,
    ...items.map((item) => `- ${item}`),
    "Data used:",
    ...used.map((item) => `- ${item}`),
    "Missing or limited GHL data:",
    ...(limited.length ? limited.map(formatRequirement) : ["- None for this section from the completed audit modules."]),
  ].join("\n");
}

function formatBusinessAdvisorAnswer(report) {
  const sectionKeys = [
    "criticalProblems",
    "revenueOpportunities",
    "aiAutomationOpportunities",
    "salesOpportunities",
    "marketingOpportunities",
    "teamPerformance",
    "todaysPriorityTasks",
    "estimatedRevenueImpact",
    "recommendedNextActions",
  ];

  const sections = sectionKeys.map((key) => formatSection(report, key));
  sections.push([
    "If I were running your business today, here are the three things I'd do first.",
    ...asArray(report.firstThreeActions).map((item, index) => `${index + 1}. ${item}`),
  ].join("\n"));

  return sections.join("\n\n");
}

module.exports = {
  buildBusinessAdvisorReport,
  formatBusinessAdvisorAnswer,
};
