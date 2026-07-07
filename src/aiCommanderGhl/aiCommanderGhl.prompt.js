const { supportedActionTypes } = require("./ghlActions");

const SUPPORTED_ACTION_TYPES = supportedActionTypes();
const ACTION_TYPE_ENUM = [...SUPPORTED_ACTION_TYPES, "unsupported"];

const EMPTY_STRING_FIELDS = [
  "name",
  "firstName",
  "lastName",
  "email",
  "phone",
  "address1",
  "city",
  "state",
  "postalCode",
  "source",
  "noteTitle",
  "noteBody",
  "taskTitle",
  "taskBody",
  "dueDate",
  "assignedTo",
  "pipelineId",
  "pipelineStageId",
  "opportunityName",
  "status",
  "pipelineName",
  "campaignId",
  "workflowId",
  "messageType",
  "messageBody",
  "subject",
  "html",
  "calendarId",
  "startTime",
  "endTime",
  "appointmentTitle",
  "appointmentStatus",
];

const payloadProperties = Object.fromEntries(
  EMPTY_STRING_FIELDS.map((field) => [field, { type: "string" }])
);

payloadProperties.tags = {
  type: "array",
  items: { type: "string" },
};
payloadProperties.customFields = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["key", "value"],
    properties: {
      key: { type: "string" },
      value: { type: "string" },
    },
  },
};
payloadProperties.stages = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["name", "position", "stageWinProbability"],
    properties: {
      name: { type: "string" },
      position: { type: "number" },
      stageWinProbability: { type: "number" },
    },
  },
};
payloadProperties.completed = { type: "boolean" };
payloadProperties.useOpportunityProbability = { type: "boolean" };
payloadProperties.monetaryValue = { type: "number" };

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "exactPlan",
    "objectsAffected",
    "messagesToSendOrCreate",
    "plannedActions",
    "unsupportedActions",
    "riskLevel",
    "destructive",
  ],
  properties: {
    summary: { type: "string" },
    exactPlan: {
      type: "array",
      items: { type: "string" },
    },
    objectsAffected: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "id", "name", "operation", "details"],
        properties: {
          type: { type: "string" },
          id: { type: "string" },
          name: { type: "string" },
          operation: { type: "string" },
          details: { type: "string" },
        },
      },
    },
    messagesToSendOrCreate: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["channel", "recipient", "subject", "body", "timing", "actionId"],
        properties: {
          channel: { type: "string" },
          recipient: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
          timing: { type: "string" },
          actionId: { type: "string" },
        },
      },
    },
    plannedActions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "actionId",
          "actionType",
          "description",
          "supported",
          "riskLevel",
          "destructive",
          "target",
          "payload",
          "unsupportedReason",
        ],
        properties: {
          actionId: { type: "string" },
          actionType: { type: "string", enum: ACTION_TYPE_ENUM },
          description: { type: "string" },
          supported: { type: "boolean" },
          riskLevel: { type: "string", enum: ["low", "medium", "high"] },
          destructive: { type: "boolean" },
          target: {
            type: "object",
            additionalProperties: false,
            required: [
              "contactId",
              "contactIdFromActionId",
              "conversationId",
              "opportunityId",
              "pipelineId",
              "campaignId",
              "calendarId",
              "workflowId",
              "notes",
            ],
            properties: {
              contactId: { type: "string" },
              contactIdFromActionId: { type: "string" },
              conversationId: { type: "string" },
              opportunityId: { type: "string" },
              pipelineId: { type: "string" },
              campaignId: { type: "string" },
              calendarId: { type: "string" },
              workflowId: { type: "string" },
              notes: { type: "string" },
            },
          },
          payload: {
            type: "object",
            additionalProperties: false,
            required: [
              ...EMPTY_STRING_FIELDS,
              "tags",
              "customFields",
              "stages",
              "completed",
              "useOpportunityProbability",
              "monetaryValue",
            ],
            properties: payloadProperties,
          },
          unsupportedReason: { type: "string" },
        },
      },
    },
    unsupportedActions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requestedAction", "reason"],
        properties: {
          requestedAction: { type: "string" },
          reason: { type: "string" },
        },
      },
    },
    riskLevel: { type: "string", enum: ["low", "medium", "high"] },
    destructive: { type: "boolean" },
  },
};

const SUPPORTED_ACTION_SUMMARY = `
Supported executable actionType values:
- get_contact: GET /contacts/:contactId
- create_contact: POST /contacts/
- upsert_contact: POST /contacts/upsert
- update_contact: PUT /contacts/:contactId
- update_contact_custom_fields: PUT /contacts/:contactId with customFields only
- add_contact_tags: POST /contacts/:contactId/tags
- remove_contact_tags: DELETE /contacts/:contactId/tags
- create_contact_note: POST /contacts/:contactId/notes
- create_contact_task: POST /contacts/:contactId/tasks
- add_contact_to_campaign: POST /contacts/:contactId/campaigns/:campaignId
- remove_contact_from_campaign: DELETE /contacts/:contactId/campaigns/:campaignId
- add_contact_to_workflow: POST /contacts/:contactId/workflow/:workflowId
- remove_contact_from_workflow: DELETE /contacts/:contactId/workflow/:workflowId
- get_pipelines: GET /opportunities/pipelines
- create_opportunity: POST /opportunities/
- create_pipeline: POST /opportunities/pipelines
- send_conversation_message: POST /conversations/messages
- create_calendar_appointment: POST /calendars/events/appointments
- get_workflows: GET /workflows/
`.trim();

function buildPlannerPrompt() {
  return `
You are GHL AI Commander, an internal admin-only planner for GoHighLevel / HighLevel.

You do not execute anything. You only produce a precise JSON plan.

This system is completely separate from the public Profixter customer-facing AI assistant. Do not mention or use the customer assistant. Do not plan public website chat behavior. Do not expose or request API keys or tokens.

Scope:
- GHL only.
- No Stripe, Gmail, Google Calendar, internal CRM, frontend, public website chat, or non-GHL automation.
- Website-related work is allowed only if the action is a GHL link, tag, campaign enrollment, workflow enrollment, form/survey reference, or GHL message. If there is no implemented action below, mark unsupported.

Hard planning rules:
- The plan endpoint never executes. Every executable action must require approval.
- Show exact objects affected, exact names, exact contacts/tags/workflows/campaigns/opportunities/messages, exact SMS/email copy, exact timing/delays, exact API actions, risk level, and destructive flag.
- Do not hide destructive or bulk work inside vague wording.
- No bulk SMS blast. If asked to message more than one contact, mark unsupported.
- No deleting contacts. No deleting workflows. No deleting pipeline unless explicitly supported; it is not supported here.
- Creating workflows or editing workflow steps is not supported by the implemented endpoint set. Adding or removing one contact from an existing workflow is supported.
- Creating forms/surveys is not supported by the implemented endpoint set.
- Creating custom field definitions is not supported here; updating custom field values on a known contact is supported.
- If any requested action cannot be performed by a supported actionType, include unsupportedActions and use this exact reason when applicable: "This action is not supported by the available GHL API endpoint."
- Use "unsupported" actionType only for non-executable explanation rows.
- If an action needs an existing GHL id and the user did not provide it, make that clear in exactPlan and mark the action unsupported rather than inventing an id.
- For a newly created contact followed by another action, put the create action first and set target.contactIdFromActionId on the dependent action to the create actionId.
- For the command "Create a test GHL contact named AI Test Contact, phone 6315991363, tag ai-test.", use create_contact with payload.name, payload.phone, and payload.tags ["ai-test"].

Risk rules:
- low: read-only, create one contact, add one tag, create one note/task.
- medium: update existing records, campaign/workflow enrollment changes, create one opportunity.
- high: send SMS/email, create pipeline, create appointment, any destructive action, any broad/bulk/ambiguous targeting.

For unused target and payload fields, return empty strings, empty arrays, false booleans, and 0 monetaryValue. The output must strictly follow the schema.

${SUPPORTED_ACTION_SUMMARY}
`.trim();
}

module.exports = {
  PLAN_SCHEMA,
  SUPPORTED_ACTION_SUMMARY,
  SUPPORTED_ACTION_TYPES,
  buildPlannerPrompt,
};
