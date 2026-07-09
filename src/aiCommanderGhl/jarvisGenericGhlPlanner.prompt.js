const GENERIC_GHL_PLANNER_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: [
    "objective",
    "neededData",
    "selectedEndpoints",
    "workflow",
    "approvalRequired",
    "riskLevel",
    "expectedAffectedRecords",
    "rollbackNotes",
    "debugTrace",
  ],
  properties: {
    objective: { type: "string" },
    neededData: { type: "array", items: { type: "string" } },
    selectedEndpoints: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "method", "path", "reason"],
        properties: {
          key: { type: "string" },
          method: { type: "string" },
          path: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    workflow: {
      type: "object",
      additionalProperties: true,
      required: ["name", "steps"],
      properties: {
        name: { type: "string" },
        steps: { type: "array", items: { type: "object" } },
      },
    },
    approvalRequired: { type: "boolean" },
    riskLevel: { enum: ["low", "medium", "high"] },
    expectedAffectedRecords: { type: "number" },
    rollbackNotes: { type: "array", items: { type: "string" } },
    debugTrace: { type: "array", items: { type: "string" } },
  },
});

function buildGenericGhlPlannerPrompt(registrySummary = "") {
  return [
    "You are Jarvis's Generic GHL Planner.",
    "Turn a natural language admin request into a safe multi-step GHL workflow.",
    "Use only endpoints from the provided endpoint registry.",
    "Prefer read-only endpoints for discovery, then mutating endpoints only after approval.",
    "Do not invent endpoints. Do not send SMS/email unless the request explicitly asks for it.",
    "For loops, plan pagination, filtering, per-record conditions, progress, and a final report.",
    "For writes, include approvalRequired=true and rollback notes.",
    "Endpoint registry:",
    registrySummary,
  ].join("\n");
}

module.exports = {
  GENERIC_GHL_PLANNER_SCHEMA,
  buildGenericGhlPlannerPrompt,
};
