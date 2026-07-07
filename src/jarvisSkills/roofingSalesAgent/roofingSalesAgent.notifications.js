const {
  sendAdminEventNotification,
  validEmail,
} = require("../../../utils/adminLeadNotification");

function cleanString(value) {
  return String(value || "").trim();
}

function notificationEmailConfigured() {
  const explicit = cleanString(process.env.JARVIS_ADMIN_ALERT_EMAIL);
  if (explicit) return validEmail(explicit);
  return true;
}

function buildSections({ conversation, reason, classification, recommendedReply }) {
  return [
    {
      title: "Lead",
      fields: [
        ["Name", conversation.name || "-"],
        ["Phone", conversation.phone || "-"],
        ["GHL contact ID", conversation.contactId || "-"],
        ["Campaign", conversation.campaignType || "roofing_siding"],
      ],
    },
    {
      title: "Jarvis",
      fields: [
        ["Reason", reason],
        ["Classification", classification || conversation.classification || "-"],
        ["Status", conversation.status || "-"],
        ["Callback time", conversation.callbackTimeText || "-"],
        ["Last incoming", conversation.lastIncomingMessage || "-"],
        ["Suggested reply", recommendedReply || conversation.lastAiReply || "-"],
      ],
    },
  ];
}

async function notifyAdmin({ conversation, reason, classification, recommendedReply }) {
  if (!notificationEmailConfigured()) {
    return {
      supported: false,
      executed: false,
      reason: "JARVIS_ADMIN_ALERT_EMAIL is not a valid email address.",
    };
  }

  const env = {
    ...process.env,
    LEADS_EMAIL:
      cleanString(process.env.JARVIS_ADMIN_ALERT_EMAIL) ||
      process.env.LEADS_EMAIL ||
      process.env.MAIL_ADMIN,
  };

  await sendAdminEventNotification(
    {
      subject:
        reason === "callback_scheduled"
          ? "ROOFING CALLBACK SCHEDULED"
          : "ROOFING SALES AGENT HUMAN TAKEOVER",
      heading:
        reason === "callback_scheduled"
          ? "Roofing callback scheduled"
          : "Roofing Sales Agent needs human takeover",
      source: "roofingSalesAgent",
      templateKey: "roofing_sales_agent_admin_alert",
      customerName: conversation.name || "",
      sections: buildSections({
        conversation,
        reason,
        classification,
        recommendedReply,
      }),
    },
    {
      env,
      logContext: {
        source: "roofingSalesAgent",
        emailType: "admin",
      },
    }
  );

  return {
    supported: true,
    executed: true,
    reason: "",
  };
}

module.exports = {
  notifyAdmin,
};
