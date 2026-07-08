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
  const oppSignals = opportunities?.data?.businessSignals || {};
  const stale30 = firstNumber(oppSignals.stale30Days);
  const stale60 = firstNumber(oppSignals.stale60Days);
  const openOpps = firstNumber(oppSignals.openCount);
  const valueTotal = firstNumber(oppSignals.valueTotal);
  const staleValue = firstNumber(oppSignals.staleValue);
  const missingValueCount = firstNumber(oppSignals.missingValueCount);
  const stageHotspots = topEntries(opportunities?.data?.byStage, 4);
  const pipelineHotspots = topEntries(opportunities?.data?.byPipeline, 3);
  const names = tagNames(tags);
  const hasRoofingAudience = names.some((name) => /roof|siding|estimate/i.test(name));
  const failingCapabilities = asArray(healthReport?.capabilities?.failing || healthReport?.failing);
  const failedRecentActions = asArray(healthReport?.failedActions);

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
      `${formatNumber(failedModules.length)} internal audit module${failedModules.length === 1 ? "" : "s"} could not be inspected: ${failedModules.map((module) => module.label).join(", ")}. Fix those scopes/endpoints before trusting the full operating picture.`
    );
  }
  if (failingCapabilities.length) {
    addUnique(
      criticalProblems,
      `${formatNumber(failingCapabilities.length)} GHL capability check${failingCapabilities.length === 1 ? "" : "s"} need attention, so Jarvis may be missing part of the account picture.`
    );
  }
  if (failedRecentActions.length) {
    addUnique(
      criticalProblems,
      `${formatNumber(failedRecentActions.length)} recent universal GHL action${failedRecentActions.length === 1 ? "" : "s"} failed or were rejected. Review these before expanding automation.`
    );
  }
  if (conversationWaiting && conversationWaiting > 0) {
    addUnique(
      criticalProblems,
      `${formatNumber(conversationWaiting)} conversations appear open, unread, or waiting. That is immediate follow-up leakage.`
    );
    addUnique(
      todaysPriorityTasks,
      `Clear the ${formatNumber(conversationWaiting)} waiting conversation${conversationWaiting === 1 ? "" : "s"} before doing lower-value cleanup.`
    );
  }
  if (stale30 && stale30 > 0) {
    addUnique(
      criticalProblems,
      `${formatNumber(stale30)} opportunities have had no visible activity for over 30 days in the scanned GHL data.`
    );
    addUnique(
      salesOpportunities,
      `Work the ${formatNumber(stale30)} stale opportunit${stale30 === 1 ? "y" : "ies"} as a rescue list before creating colder demand.`
    );
    addUnique(
      todaysPriorityTasks,
      `Assign same-day follow-up tasks for the oldest ${formatNumber(Math.min(stale30, 25))} stale opportunit${Math.min(stale30, 25) === 1 ? "y" : "ies"}.`
    );
  }
  if (stale60 && stale60 > 0) {
    addUnique(
      criticalProblems,
      `${formatNumber(stale60)} opportunities appear stalled for over 60 days. Treat these as save-or-close decisions, not normal pipeline inventory.`
    );
  }
  if (contacts?.data?.partial === true) {
    addUnique(
      criticalProblems,
      "Contact visibility is partial. Jarvis could not confirm the exact full contact count, so audience sizing may be incomplete."
    );
  }
  if (pipelineTotal === 0 || stageTotal === 0) {
    addUnique(
      criticalProblems,
      "The pipeline/stage structure is missing or unreadable. Sales reporting will be weak until pipeline stages are clear."
    );
  }
  if (workflowTotal === 0) {
    addUnique(
      aiAutomationOpportunities,
      "No workflows were found. Build automated speed-to-lead, missed-reply, stale-opportunity, and appointment-reminder workflows."
    );
  }
  if (campaigns?.status === "failed") {
    addUnique(
      marketingOpportunities,
      "Jarvis could not inspect GHL campaigns. Fix campaign visibility so reactivation and nurture performance can be reviewed."
    );
  }

  if (contactsTotal && contactsTotal > 0) {
    addUnique(
      revenueOpportunities,
      `${formatNumber(contactsTotal)} contacts are available to segment for reactivation, estimates, memberships, or seasonal offers.`
    );
  }
  if (openOpps && openOpps > 0) {
    addUnique(
      revenueOpportunities,
      `${formatNumber(openOpps)} open opportunities are visible. Prioritize the ones in late-stage or stale stages before adding more leads.`
    );
  } else if (opportunityTotal && opportunityTotal > 0) {
    addUnique(
      revenueOpportunities,
      `${formatNumber(opportunityTotal)} opportunities are visible. Use stage and activity age to find the fastest revenue path.`
    );
  }
  if (staleValue && staleValue > 0) {
    addUnique(
      revenueOpportunities,
      `${formatMoney(staleValue)} in stale opportunity value is visible in the scanned GHL data.`
    );
  }
  if (hasRoofingAudience) {
    addUnique(
      marketingOpportunities,
      "Roofing/siding/estimate tags exist. Use them for a focused re-engagement campaign instead of a broad blast."
    );
  }
  if (tagTotal && tagTotal > 0) {
    addUnique(
      marketingOpportunities,
      `${formatNumber(tagTotal)} tags can support segmented campaigns. Start with warm, service-specific, and estimate-related audiences.`
    );
  }
  if (campaignTotal && campaignTotal > 0) {
    addUnique(
      marketingOpportunities,
      `${formatNumber(campaignTotal)} campaigns are visible. Review which ones are active, stale, or missing reply-handling rules.`
    );
  }

  if (conversationWaiting && conversationWaiting > 0) {
    addUnique(
      aiAutomationOpportunities,
      "Create an AI-assisted inbox triage rule for unread/open conversations: classify intent, draft reply, tag urgency, and notify the owner."
    );
  }
  if (stale30 && stale30 > 0) {
    addUnique(
      aiAutomationOpportunities,
      "Create a stale-opportunity workflow that adds a task, drafts a follow-up, and escalates no-response deals after 48 hours."
    );
  }
  if (tagTotal && tagTotal > 10) {
    addUnique(
      aiAutomationOpportunities,
      "Use tags as automation triggers for qualification, campaign enrollment, and owner notifications."
    );
  }
  if (workflowTotal && workflowTotal > 0) {
    addUnique(
      aiAutomationOpportunities,
      `${formatNumber(workflowTotal)} workflows are visible. Audit them for missed-reply handling, owner notification, and stop conditions.`
    );
  }

  if (stageHotspots.length) {
    addUnique(
      salesOpportunities,
      `Pipeline concentration: ${stageHotspots.map((item) => `${item.name} has ${formatNumber(item.count)}`).join("; ")}. These stages should drive today's call list.`
    );
  }
  if (pipelineHotspots.length) {
    addUnique(
      salesOpportunities,
      `Highest-volume pipelines: ${pipelineHotspots.map((item) => `${item.name} (${formatNumber(item.count)})`).join(", ")}. Start there for sales management.`
    );
  }
  if (missingValueCount && missingValueCount > 0) {
    addUnique(
      salesOpportunities,
      `${formatNumber(missingValueCount)} opportunities are missing a usable value in the scanned data. Add values so revenue forecasts are not blind.`
    );
  }

  if (userTotal && userTotal > 0) {
    addUnique(
      teamPerformance,
      `${formatNumber(userTotal)} team member${userTotal === 1 ? "" : "s"} are visible in GHL. Next step is measuring response time, stale owner queues, and conversion by owner.`
    );
  } else if (users?.status === "failed") {
    addUnique(
      teamPerformance,
      "Jarvis could not inspect users/team members, so owner accountability cannot be measured yet."
    );
  }
  if (calendarTotal && calendarTotal > 0) {
    addUnique(
      teamPerformance,
      `${formatNumber(calendarTotal)} calendar${calendarTotal === 1 ? "" : "s"} are visible. Compare appointment volume against open opportunities to find booking gaps.`
    );
  }
  if (conversationWaiting && conversationWaiting > 0) {
    addUnique(
      teamPerformance,
      "Unread/open conversations indicate response-time discipline needs attention today."
    );
  }
  if (stale30 && stale30 > 0) {
    addUnique(
      teamPerformance,
      "Stale opportunities indicate follow-up ownership or task discipline is breaking down."
    );
  }

  if (valueTotal && valueTotal > 0) {
    addUnique(
      estimatedRevenueImpact,
      `${formatMoney(valueTotal)} in visible opportunity value was returned by GHL in the scanned opportunity set.`
    );
    if (staleValue && staleValue > 0) {
      addUnique(
        estimatedRevenueImpact,
        `${formatMoney(staleValue)} of that value appears tied to opportunities with no visible activity for over 30 days.`
      );
    }
  } else {
    addUnique(
      estimatedRevenueImpact,
      "Exact dollar impact is unavailable because GHL did not return usable opportunity values in this audit. The highest measurable impact is recovering waiting conversations and stale opportunities."
    );
  }
  if (conversationWaiting && conversationWaiting > 0) {
    addUnique(
      estimatedRevenueImpact,
      `${formatNumber(conversationWaiting)} waiting conversation${conversationWaiting === 1 ? "" : "s"} could represent near-term revenue at risk if not answered quickly.`
    );
  }
  if (stale30 && stale30 > 0 && !(staleValue && staleValue > 0)) {
    addUnique(
      estimatedRevenueImpact,
      `${formatNumber(stale30)} stale opportunit${stale30 === 1 ? "y needs" : "ies need"} dollar values or average job value before Jarvis can calculate a real recovery forecast.`
    );
  }

  addUnique(
    recommendedNextActions,
    "Turn the audit into an owner-based action list: waiting conversations first, stale opportunities second, campaign/automation gaps third."
  );
  if (failedModules.length || failingCapabilities.length) {
    addUnique(
      recommendedNextActions,
      "Fix failed inspection modules so Jarvis can make stronger recommendations from complete data."
    );
  }
  if (contactsTotal && contactsTotal > 0) {
    addUnique(
      recommendedNextActions,
      "Segment contacts by service interest, source, stage, last activity, and reply status before launching campaigns."
    );
  }
  if (pipelineTotal && stageTotal) {
    addUnique(
      recommendedNextActions,
      "Standardize the pipeline so every opportunity has a clear next action, owner, and stale-date rule."
    );
  }

  if (!criticalProblems.length) {
    criticalProblems.push("No critical business problem is obvious from the data Jarvis could inspect, but incomplete GHL fields may still hide issues.");
  }
  if (!revenueOpportunities.length) {
    revenueOpportunities.push("No clear revenue opportunity was measurable from this audit. Add opportunity values, stages, and last-activity fields to improve revenue analysis.");
  }
  if (!aiAutomationOpportunities.length) {
    aiAutomationOpportunities.push("Automation opportunities could not be confirmed from the available data. Start by mapping lead intake, missed replies, stale deals, and appointment follow-up.");
  }
  if (!salesOpportunities.length) {
    salesOpportunities.push("Sales opportunities could not be ranked from the available data. Add or verify opportunity stages, values, owners, and last activity.");
  }
  if (!marketingOpportunities.length) {
    marketingOpportunities.push("Marketing opportunities could not be ranked from the available data. Add clear service-interest tags and campaign status data.");
  }
  if (!teamPerformance.length) {
    teamPerformance.push("Team performance cannot be measured deeply from this audit yet. Jarvis needs owner, response-time, task, and appointment outcome data.");
  }
  if (!todaysPriorityTasks.length) {
    todaysPriorityTasks.push("Review the highest-value opportunities, then check unread conversations and campaign/audience gaps.");
  }
  if (!recommendedNextActions.length) {
    recommendedNextActions.push("Run a deeper account audit after contacts, opportunities, campaigns, and users are all readable.");
  }

  const firstThreeActions = [
    todaysPriorityTasks[0],
    salesOpportunities[0],
    recommendedNextActions[0],
  ].filter(Boolean).slice(0, 3);

  while (firstThreeActions.length < 3) {
    firstThreeActions.push([
      "Make sure every active opportunity has an owner, next task, value, and follow-up date.",
      "Use tags and pipeline stage to build one focused reactivation audience.",
      "Create automation for missed replies and stale opportunities before scaling campaigns.",
    ][firstThreeActions.length]);
  }

  return {
    action,
    title: `${label} Business Operations Analysis`,
    criticalProblems,
    revenueOpportunities,
    aiAutomationOpportunities,
    salesOpportunities,
    marketingOpportunities,
    teamPerformance,
    todaysPriorityTasks,
    estimatedRevenueImpact,
    recommendedNextActions,
    firstThreeActions,
  };
}

function formatSection(title, items) {
  return [`${title}:`, ...asArray(items).map((item) => `- ${item}`)].join("\n");
}

function formatBusinessAdvisorAnswer(report) {
  const sections = [
    formatSection("Critical Problems", report.criticalProblems),
    formatSection("Revenue Opportunities", report.revenueOpportunities),
    formatSection("AI Automation Opportunities", report.aiAutomationOpportunities),
    formatSection("Sales Opportunities", report.salesOpportunities),
    formatSection("Marketing Opportunities", report.marketingOpportunities),
    formatSection("Team Performance", report.teamPerformance),
    formatSection("Today's Priority Tasks", report.todaysPriorityTasks),
    formatSection("Estimated Revenue Impact", report.estimatedRevenueImpact),
    formatSection("Recommended Next Actions", report.recommendedNextActions),
    [
      "If I were running your business today, here are the three things I'd do first.",
      ...asArray(report.firstThreeActions).map((item, index) => `${index + 1}. ${item}`),
    ].join("\n"),
  ];

  return sections.join("\n\n");
}

module.exports = {
  buildBusinessAdvisorReport,
  formatBusinessAdvisorAnswer,
};
