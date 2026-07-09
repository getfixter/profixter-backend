const { getLocationId, request, redact } = require("./ghlClient");

const UNSUPPORTED_MESSAGE =
  "This action is not supported by the available GHL API endpoint.";

const RISK_ORDER = { low: 1, medium: 2, high: 3 };

function cleanString(value) {
  return String(value ?? "").trim();
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item)).filter(Boolean);
}

function normalizePhone(phone) {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return cleanString(phone);
}

function splitName(name) {
  const parts = cleanString(name).split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || "",
    lastName: parts.slice(1).join(" "),
  };
}

function pickPayload(action, keys) {
  const payload = action?.payload || {};
  return Object.fromEntries(
    keys
      .map((key) => [key, payload[key]])
      .filter(([, value]) => {
        if (Array.isArray(value)) return value.length > 0;
        return value !== undefined && value !== null && cleanString(value) !== "";
      })
  );
}

function compactBody(body) {
  return Object.fromEntries(
    Object.entries(body || {}).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === "object") return Object.keys(value).length > 0;
      return value !== undefined && value !== null && cleanString(value) !== "";
    })
  );
}

function optionalNumber(value) {
  if (value === "" || value === null || value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function parseJsonObjectText(value, fieldName) {
  const text = cleanString(value);
  if (!text) return {};
  let parsed = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`${fieldName} must be valid JSON.`), {
      statusCode: 400,
    });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error(`${fieldName} must be a JSON object.`), {
      statusCode: 400,
    });
  }
  return parsed;
}

function getContactId(action, executionContext) {
  const target = action?.target || {};
  const direct = cleanString(target.contactId);
  if (direct) return direct;

  const fromActionId = cleanString(target.contactIdFromActionId);
  if (fromActionId) {
    const value = executionContext?.actionResults?.[fromActionId]?.contactId;
    if (value) return value;
  }

  return "";
}

function getRequiredContactId(action, executionContext) {
  const contactId = getContactId(action, executionContext);
  if (!contactId) {
    throw Object.assign(new Error("contactId is required for this GHL action"), {
      statusCode: 400,
    });
  }
  return contactId;
}

function firstResultId(data, keys) {
  for (const key of keys) {
    const parts = key.split(".");
    let current = data;
    for (const part of parts) {
      current = current?.[part];
    }
    if (current) return cleanString(current);
  }
  return "";
}

function ensureLocationId(body) {
  return {
    ...body,
    locationId: cleanString(body.locationId) || getLocationId(),
  };
}

function actionDoc({
  method,
  endpoint,
  riskLevel = "low",
  destructive = false,
  description,
  docs,
  build,
  extract,
}) {
  return {
    method,
    endpoint,
    riskLevel,
    destructive,
    description,
    docs,
    build,
    extract: extract || (() => ({})),
  };
}

const ACTION_DEFINITIONS = {
  get_contact: actionDoc({
    method: "GET",
    endpoint: "/contacts/:contactId",
    description: "Retrieve one GHL contact by contact ID.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/get-contact",
    build(action, executionContext) {
      const contactId = getRequiredContactId(action, executionContext);
      return { method: "GET", path: `/contacts/${encodeURIComponent(contactId)}` };
    },
    extract(data) {
      return { contactId: firstResultId(data, ["contact.id", "id", "contactId"]) };
    },
  }),

  create_contact: actionDoc({
    method: "POST",
    endpoint: "/contacts/",
    description: "Create a GHL contact. Tags may be assigned during creation.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/create-contact/",
    build(action) {
      const payload = action.payload || {};
      const nameParts = splitName(payload.name);
      const firstName = cleanString(payload.firstName) || nameParts.firstName;
      const lastName = cleanString(payload.lastName) || nameParts.lastName;
      const body = ensureLocationId(
        compactBody({
          firstName,
          lastName,
          name: firstName ? "" : cleanString(payload.name),
          email: cleanString(payload.email).toLowerCase(),
          phone: payload.phone ? normalizePhone(payload.phone) : "",
          address1: cleanString(payload.address1),
          city: cleanString(payload.city),
          state: cleanString(payload.state),
          postalCode: cleanString(payload.postalCode),
          source: cleanString(payload.source),
          tags: cleanList(payload.tags),
        })
      );

      if (!body.firstName && !body.name) {
        throw Object.assign(new Error("firstName or name is required"), {
          statusCode: 400,
        });
      }
      if (!body.email && !body.phone) {
        throw Object.assign(new Error("email or phone is required"), {
          statusCode: 400,
        });
      }

      return { method: "POST", path: "/contacts/", body };
    },
    extract(data) {
      return {
        contactId: firstResultId(data, [
          "contact.id",
          "contact._id",
          "id",
          "_id",
          "contactId",
          "meta.contactId",
        ]),
      };
    },
  }),

  upsert_contact: actionDoc({
    method: "POST",
    endpoint: "/contacts/upsert",
    description: "Create or update a GHL contact using HighLevel contact matching.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/upsert-contact/",
    build(action) {
      const payload = action.payload || {};
      const nameParts = splitName(payload.name);
      const body = ensureLocationId(
        compactBody({
          firstName: cleanString(payload.firstName) || nameParts.firstName,
          lastName: cleanString(payload.lastName) || nameParts.lastName,
          name: cleanString(payload.name),
          email: cleanString(payload.email).toLowerCase(),
          phone: payload.phone ? normalizePhone(payload.phone) : "",
          address1: cleanString(payload.address1),
          city: cleanString(payload.city),
          state: cleanString(payload.state),
          postalCode: cleanString(payload.postalCode),
          source: cleanString(payload.source),
          customFields: Array.isArray(payload.customFields)
            ? payload.customFields
                .map((field) => ({
                  key: cleanString(field?.key),
                  field_value: field?.value ?? "",
                  value: field?.value ?? "",
                }))
                .filter((field) => field.key)
            : [],
        })
      );

      if (!body.email && !body.phone) {
        throw Object.assign(new Error("email or phone is required"), {
          statusCode: 400,
        });
      }

      return { method: "POST", path: "/contacts/upsert", body };
    },
    extract(data) {
      return {
        contactId: firstResultId(data, [
          "contact.id",
          "contact._id",
          "id",
          "_id",
          "contactId",
          "meta.contactId",
        ]),
      };
    },
  }),

  update_contact: actionDoc({
    method: "PUT",
    endpoint: "/contacts/:contactId",
    riskLevel: "medium",
    description:
      "Update a GHL contact by contact ID. Tags are intentionally excluded; use tag actions instead.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/update-contact/",
    build(action, executionContext) {
      const contactId = getRequiredContactId(action, executionContext);
      const body = compactBody(
        pickPayload(action, [
          "firstName",
          "lastName",
          "name",
          "email",
          "phone",
          "address1",
          "city",
          "state",
          "postalCode",
          "source",
        ])
      );
      if (body.email) body.email = cleanString(body.email).toLowerCase();
      if (body.phone) body.phone = normalizePhone(body.phone);
      if (!Object.keys(body).length) {
        throw Object.assign(new Error("At least one contact field is required"), {
          statusCode: 400,
        });
      }
      return {
        method: "PUT",
        path: `/contacts/${encodeURIComponent(contactId)}`,
        body,
      };
    },
    extract(data) {
      return { contactId: firstResultId(data, ["contact.id", "id", "contactId"]) };
    },
  }),

  update_contact_custom_fields: actionDoc({
    method: "PUT",
    endpoint: "/contacts/:contactId",
    riskLevel: "medium",
    description: "Update custom field values on one GHL contact.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/update-contact/",
    build(action, executionContext) {
      const contactId = getRequiredContactId(action, executionContext);
      const customFields = Array.isArray(action.payload?.customFields)
        ? action.payload.customFields
            .map((field) => ({
              key: cleanString(field?.key),
              field_value: field?.value ?? "",
              value: field?.value ?? "",
            }))
            .filter((field) => field.key)
        : [];
      if (!customFields.length) {
        throw Object.assign(new Error("customFields are required"), {
          statusCode: 400,
        });
      }
      return {
        method: "PUT",
        path: `/contacts/${encodeURIComponent(contactId)}`,
        body: { customFields },
      };
    },
    extract(data) {
      return { contactId: firstResultId(data, ["contact.id", "id", "contactId"]) };
    },
  }),

  add_contact_tags: actionDoc({
    method: "POST",
    endpoint: "/contacts/:contactId/tags",
    description: "Add one or more tags to a GHL contact.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/add-tags",
    build(action, executionContext) {
      const contactId = getRequiredContactId(action, executionContext);
      const tags = cleanList(action.payload?.tags);
      if (!tags.length) {
        throw Object.assign(new Error("tags are required"), { statusCode: 400 });
      }
      return {
        method: "POST",
        path: `/contacts/${encodeURIComponent(contactId)}/tags`,
        body: { tags },
      };
    },
    extract(data) {
      return { contactId: firstResultId(data, ["contact.id", "id", "contactId"]) };
    },
  }),

  remove_contact_tags: actionDoc({
    method: "DELETE",
    endpoint: "/contacts/:contactId/tags",
    riskLevel: "medium",
    destructive: true,
    description: "Remove one or more tags from a GHL contact.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/remove-tags",
    build(action, executionContext) {
      const contactId = getRequiredContactId(action, executionContext);
      const tags = cleanList(action.payload?.tags);
      if (!tags.length) {
        throw Object.assign(new Error("tags are required"), { statusCode: 400 });
      }
      return {
        method: "DELETE",
        path: `/contacts/${encodeURIComponent(contactId)}/tags`,
        body: { tags },
      };
    },
  }),

  create_contact_note: actionDoc({
    method: "POST",
    endpoint: "/contacts/:contactId/notes",
    description: "Create a note on a GHL contact.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/create-note",
    build(action, executionContext) {
      const contactId = getRequiredContactId(action, executionContext);
      const body = compactBody({
        title: cleanString(action.payload?.noteTitle),
        body: cleanString(action.payload?.noteBody),
      });
      if (!body.body) {
        throw Object.assign(new Error("noteBody is required"), {
          statusCode: 400,
        });
      }
      return {
        method: "POST",
        path: `/contacts/${encodeURIComponent(contactId)}/notes`,
        body,
      };
    },
    extract(data) {
      return { noteId: firstResultId(data, ["note.id", "id"]) };
    },
  }),

  create_contact_task: actionDoc({
    method: "POST",
    endpoint: "/contacts/:contactId/tasks",
    description: "Create a task on a GHL contact.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/create-task",
    build(action, executionContext) {
      const contactId = getRequiredContactId(action, executionContext);
      const body = compactBody({
        title: cleanString(action.payload?.taskTitle),
        body: cleanString(action.payload?.taskBody),
        dueDate: cleanString(action.payload?.dueDate),
        completed: action.payload?.completed === true,
        assignedTo: cleanString(action.payload?.assignedTo),
      });
      if (!body.title || !body.dueDate) {
        throw Object.assign(new Error("taskTitle and dueDate are required"), {
          statusCode: 400,
        });
      }
      return {
        method: "POST",
        path: `/contacts/${encodeURIComponent(contactId)}/tasks`,
        body,
      };
    },
    extract(data) {
      return { taskId: firstResultId(data, ["task.id", "id"]) };
    },
  }),

  add_contact_to_campaign: actionDoc({
    method: "POST",
    endpoint: "/contacts/:contactId/campaigns/:campaignId",
    riskLevel: "medium",
    description: "Add one GHL contact to one GHL campaign.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/add-contact-to-campaign",
    build(action, executionContext) {
      const contactId = getRequiredContactId(action, executionContext);
      const campaignId =
        cleanString(action.target?.campaignId) || cleanString(action.payload?.campaignId);
      if (!campaignId) {
        throw Object.assign(new Error("campaignId is required"), {
          statusCode: 400,
        });
      }
      return {
        method: "POST",
        path: `/contacts/${encodeURIComponent(contactId)}/campaigns/${encodeURIComponent(
          campaignId
        )}`,
      };
    },
  }),

  remove_contact_from_campaign: actionDoc({
    method: "DELETE",
    endpoint: "/contacts/:contactId/campaigns/:campaignId",
    riskLevel: "medium",
    destructive: true,
    description: "Remove one GHL contact from one GHL campaign.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/remove-contact-from-campaign",
    build(action, executionContext) {
      const contactId = getRequiredContactId(action, executionContext);
      const campaignId =
        cleanString(action.target?.campaignId) || cleanString(action.payload?.campaignId);
      if (!campaignId) {
        throw Object.assign(new Error("campaignId is required"), {
          statusCode: 400,
        });
      }
      return {
        method: "DELETE",
        path: `/contacts/${encodeURIComponent(contactId)}/campaigns/${encodeURIComponent(
          campaignId
        )}`,
      };
    },
  }),

  add_contact_to_workflow: actionDoc({
    method: "POST",
    endpoint: "/contacts/:contactId/workflow/:workflowId",
    riskLevel: "medium",
    description:
      "Add one GHL contact to one existing GHL workflow. Creating workflows is not supported.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/add-contact-to-workflow",
    build(action, executionContext) {
      const contactId = getRequiredContactId(action, executionContext);
      const workflowId =
        cleanString(action.target?.workflowId) || cleanString(action.payload?.workflowId);
      if (!workflowId) {
        throw Object.assign(new Error("workflowId is required"), {
          statusCode: 400,
        });
      }
      return {
        method: "POST",
        path: `/contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(
          workflowId
        )}`,
      };
    },
  }),

  remove_contact_from_workflow: actionDoc({
    method: "DELETE",
    endpoint: "/contacts/:contactId/workflow/:workflowId",
    riskLevel: "medium",
    destructive: true,
    description: "Remove one GHL contact from one existing GHL workflow.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/contacts/delete-contact-from-workflow",
    build(action, executionContext) {
      const contactId = getRequiredContactId(action, executionContext);
      const workflowId =
        cleanString(action.target?.workflowId) || cleanString(action.payload?.workflowId);
      if (!workflowId) {
        throw Object.assign(new Error("workflowId is required"), {
          statusCode: 400,
        });
      }
      return {
        method: "DELETE",
        path: `/contacts/${encodeURIComponent(contactId)}/workflow/${encodeURIComponent(
          workflowId
        )}`,
      };
    },
  }),

  get_pipelines: actionDoc({
    method: "GET",
    endpoint: "/opportunities/pipelines",
    description: "List GHL opportunity pipelines.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/opportunities/get-pipelines",
    build() {
      return {
        method: "GET",
        path: "/opportunities/pipelines",
        query: { locationId: getLocationId() },
      };
    },
  }),

  create_opportunity: actionDoc({
    method: "POST",
    endpoint: "/opportunities/",
    riskLevel: "medium",
    description: "Create a GHL opportunity linked to a contact.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/opportunities/create-opportunity",
    build(action, executionContext) {
      const payload = action.payload || {};
      const contactId = getRequiredContactId(action, executionContext);
      const body = ensureLocationId(
        compactBody({
          pipelineId: cleanString(payload.pipelineId),
          name: cleanString(payload.opportunityName) || cleanString(payload.name),
          pipelineStageId: cleanString(payload.pipelineStageId),
          status: cleanString(payload.status) || "open",
          contactId,
          monetaryValue: optionalNumber(payload.monetaryValue),
          assignedTo: cleanString(payload.assignedTo),
          source: cleanString(payload.source),
        })
      );
      if (!body.pipelineId || !body.name || !body.status || !body.contactId) {
        throw Object.assign(
          new Error("pipelineId, opportunityName, status, and contactId are required"),
          { statusCode: 400 }
        );
      }
      return { method: "POST", path: "/opportunities/", body };
    },
    extract(data) {
      return {
        opportunityId: firstResultId(data, ["opportunity.id", "id"]),
      };
    },
  }),

  upsert_opportunity: actionDoc({
    method: "POST",
    endpoint: "/opportunities/upsert",
    riskLevel: "medium",
    description: "Create or update a GHL opportunity linked to a contact.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/opportunities/upsert-opportunity",
    build(action, executionContext) {
      const payload = action.payload || {};
      const contactId = getRequiredContactId(action, executionContext);
      const body = ensureLocationId(
        compactBody({
          pipelineId: cleanString(payload.pipelineId),
          name: cleanString(payload.opportunityName) || cleanString(payload.name),
          pipelineStageId: cleanString(payload.pipelineStageId),
          status: cleanString(payload.status) || "open",
          contactId,
          monetaryValue: optionalNumber(payload.monetaryValue),
          assignedTo: cleanString(payload.assignedTo),
          source: cleanString(payload.source),
        })
      );
      if (!body.pipelineId || !body.name || !body.status || !body.contactId) {
        throw Object.assign(
          new Error("pipelineId, opportunityName, status, and contactId are required"),
          { statusCode: 400 }
        );
      }
      return { method: "POST", path: "/opportunities/upsert", body };
    },
    extract(data) {
      return {
        opportunityId: firstResultId(data, ["opportunity.id", "id"]),
      };
    },
  }),

  create_pipeline: actionDoc({
    method: "POST",
    endpoint: "/opportunities/pipelines",
    riskLevel: "high",
    description: "Create a GHL opportunity pipeline with stages.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/opportunities/create-pipeline",
    build(action) {
      const stages = Array.isArray(action.payload?.stages)
        ? action.payload.stages
            .map((stage, index) =>
              compactBody({
                name: cleanString(stage?.name),
                position:
                  Number.isFinite(Number(stage?.position)) && Number(stage.position) > 0
                    ? Number(stage.position)
                    : index + 1,
                stageWinProbability:
                  stage?.stageWinProbability === "" ||
                  stage?.stageWinProbability === null ||
                  stage?.stageWinProbability === undefined
                    ? undefined
                    : Number(stage.stageWinProbability),
              })
            )
            .filter((stage) => stage.name)
        : [];
      const body = ensureLocationId(
        compactBody({
          name: cleanString(action.payload?.pipelineName),
          stages,
          useOpportunityProbability:
            action.payload?.useOpportunityProbability === true,
        })
      );
      if (!body.name || !stages.length) {
        throw Object.assign(new Error("pipelineName and at least one stage are required"), {
          statusCode: 400,
        });
      }
      return { method: "POST", path: "/opportunities/pipelines", body };
    },
    extract(data) {
      return { pipelineId: firstResultId(data, ["pipeline.id", "id"]) };
    },
  }),

  send_conversation_message: actionDoc({
    method: "POST",
    endpoint: "/conversations/messages",
    riskLevel: "high",
    description: "Send one GHL conversation SMS or email message.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/conversations/send-a-new-message",
    build(action, executionContext) {
      const payload = action.payload || {};
      const contactId = getContactId(action, executionContext);
      const conversationId = cleanString(action.target?.conversationId);
      const type = cleanString(payload.messageType).toUpperCase();
      if (!["SMS", "EMAIL"].includes(type)) {
        throw Object.assign(new Error("messageType must be SMS or EMAIL"), {
          statusCode: 400,
        });
      }
      if (!contactId && !conversationId) {
        throw Object.assign(new Error("contactId or conversationId is required"), {
          statusCode: 400,
        });
      }
      const body = compactBody({
        type,
        contactId,
        conversationId,
        message: cleanString(payload.messageBody),
        subject: cleanString(payload.subject),
        html: cleanString(payload.html),
      });
      if (!body.message && !body.html) {
        throw Object.assign(new Error("messageBody or html is required"), {
          statusCode: 400,
        });
      }
      return { method: "POST", path: "/conversations/messages", body };
    },
    extract(data) {
      return { messageId: firstResultId(data, ["message.id", "id", "messageId"]) };
    },
  }),

  create_calendar_appointment: actionDoc({
    method: "POST",
    endpoint: "/calendars/events/appointments",
    riskLevel: "high",
    description: "Create a GHL calendar appointment.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/calendars/create-appointment",
    build(action, executionContext) {
      const payload = action.payload || {};
      const contactId = getContactId(action, executionContext);
      const body = ensureLocationId(
        compactBody({
          calendarId: cleanString(payload.calendarId),
          contactId,
          startTime: cleanString(payload.startTime),
          endTime: cleanString(payload.endTime),
          title: cleanString(payload.appointmentTitle),
          appointmentStatus: cleanString(payload.appointmentStatus),
          assignedUserId: cleanString(payload.assignedTo),
        })
      );
      if (!body.calendarId || !body.contactId || !body.startTime || !body.endTime) {
        throw Object.assign(
          new Error("calendarId, contactId, startTime, and endTime are required"),
          { statusCode: 400 }
        );
      }
      return { method: "POST", path: "/calendars/events/appointments", body };
    },
    extract(data) {
      return {
        appointmentId: firstResultId(data, ["appointment.id", "event.id", "id"]),
      };
    },
  }),

  get_workflows: actionDoc({
    method: "GET",
    endpoint: "/workflows/",
    description:
      "Read available GHL workflows. Creating or deleting workflows is not supported in this version.",
    docs: "https://marketplace.gohighlevel.com/docs/ghl/workflows/get-workflow",
    build() {
      return { method: "GET", path: "/workflows/", query: { locationId: getLocationId() } };
    },
  }),

  sync_estimate_csv_with_ghl: actionDoc({
    method: "INTERNAL",
    endpoint: "jarvis://csv/sync-estimate-csv-with-ghl",
    riskLevel: "medium",
    description:
      "Process an uploaded estimate CSV, find existing GHL contacts, and add missing roofing/siding tags after approval. Missing contacts are reported, not created.",
    docs: "internal Jarvis CSV processor",
    build(action) {
      const files = Array.isArray(action.payload?.files) ? action.payload.files : [];
      return {
        method: "INTERNAL",
        path: "jarvis://csv/sync-estimate-csv-with-ghl",
        body: {
          files: files.map((file) => ({
            uploadId: cleanString(file?.uploadId),
            originalName: cleanString(file?.originalName),
            extension: cleanString(file?.extension),
            size: Number(file?.size || 0),
          })),
          createMissingContacts: false,
        },
      };
    },
    extract(data) {
      return { report: data };
    },
  }),

  universal_ghl_request: actionDoc({
    method: "UNIVERSAL",
    endpoint: "jarvis://ghl/universal",
    riskLevel: "high",
    description:
      "Execute one registry-approved GHL endpoint through Jarvis's universal executor after approval when required.",
    docs: "internal Jarvis universal GHL executor",
    build(action) {
      const payload = action.payload || {};
      const method = cleanString(payload.universalMethod).toUpperCase();
      const path = cleanString(payload.universalPath);
      if (!method || !path) {
        throw Object.assign(new Error("universalMethod and universalPath are required"), {
          statusCode: 400,
        });
      }
      const query = parseJsonObjectText(payload.universalQueryJson, "universalQueryJson");
      const body = parseJsonObjectText(payload.universalBodyJson, "universalBodyJson");
      return {
        method: "UNIVERSAL",
        path: "jarvis://ghl/universal",
        body: {
          method,
          path,
          query: redact(query),
          body: redact(body),
          reason: cleanString(payload.universalReason),
          dryRun: payload.dryRun === true,
          confirmationPhrase: cleanString(payload.confirmationPhrase) ? "[PROVIDED]" : "",
        },
      };
    },
    extract(data) {
      return { report: data };
    },
  }),

  jarvis_workflow: actionDoc({
    method: "WORKFLOW",
    endpoint: "jarvis://workflow",
    riskLevel: "high",
    description:
      "Execute a composed Jarvis workflow made of primitives such as loops, conditions, variables, transforms, reports, and registry-approved GHL API calls.",
    docs: "internal Jarvis workflow executor",
    build(action) {
      const payload = action.payload || {};
      const workflow = parseJsonObjectText(payload.workflowJson, "workflowJson");
      const steps = Array.isArray(workflow.steps) ? workflow.steps : [];
      const name = cleanString(payload.workflowName || workflow.name || "jarvis_workflow");
      if (!steps.length) {
        throw Object.assign(new Error("workflowJson.steps is required"), {
          statusCode: 400,
        });
      }
      return {
        method: "WORKFLOW",
        path: "jarvis://workflow",
        body: {
          name,
          stepCount: steps.length,
          dryRun: payload.dryRun === true,
          approvalRequired: true,
          primitives: [
            "loop",
            "condition",
            "set",
            "array_push",
            "map",
            "filter",
            "delay",
            "api_call",
            "progress",
            "report",
          ],
        },
      };
    },
    extract(data) {
      return { workflow: data };
    },
  }),

  generic_ghl_workflow: actionDoc({
    method: "WORKFLOW",
    endpoint: "jarvis://ghl/generic-workflow",
    riskLevel: "high",
    description:
      "Execute a Generic GHL Planner workflow through Universal GHL Executor after approval.",
    docs: "internal Jarvis Generic GHL Planner workflow",
    build(action) {
      const payload = action.payload || {};
      const plan = parseJsonObjectText(payload.genericPlanJson, "genericPlanJson");
      const endpoints = Array.isArray(plan.selectedEndpoints) ? plan.selectedEndpoints : [];
      return {
        method: "WORKFLOW",
        path: "jarvis://ghl/generic-workflow",
        body: {
          objective: cleanString(plan.objective),
          operation: cleanString(plan.operation),
          approvalRequired: plan.approvalRequired === true,
          riskLevel: cleanString(plan.riskLevel),
          expectedAffectedRecords: Number(plan.expectedAffectedRecords || 0),
          endpoints: endpoints.map((endpoint) => ({
            key: cleanString(endpoint.key),
            method: cleanString(endpoint.method),
            path: cleanString(endpoint.path),
          })),
          debugTrace: Array.isArray(plan.debugTrace) ? plan.debugTrace.slice(0, 20) : [],
        },
      };
    },
    extract(data) {
      return { report: data };
    },
  }),

  jarvis_campaign_template_create: actionDoc({
    method: "INTERNAL",
    endpoint: "jarvis://campaigns/templates",
    riskLevel: "medium",
    description:
      "Create a reusable Jarvis campaign template. Starting the campaign remains a separate approval.",
    docs: "internal Jarvis campaign builder",
    build(action) {
      const template = parseJsonObjectText(
        action.payload?.campaignTemplateJson,
        "campaignTemplateJson"
      );
      return {
        method: "INTERNAL",
        path: "jarvis://campaigns/templates",
        body: {
          campaignName: cleanString(template.campaignName),
          audienceType: cleanString(template.audienceDefinition?.type),
          tags: cleanList(template.audienceDefinition?.tags),
          messageSteps: Array.isArray(template.messageSteps)
            ? template.messageSteps.length
            : 0,
          testMode: template.testMode === true,
          approvalBeforeSending: template.approvalBeforeSending !== false,
          startsCampaign: false,
        },
      };
    },
    extract(data) {
      return { campaign: data?.campaign || data };
    },
  }),

  contact_owner_assignment: actionDoc({
    method: "WORKFLOW",
    endpoint: "jarvis://contacts/owner-assignment",
    riskLevel: "medium",
    description:
      "Assign one resolved GHL owner to a saved set of tagged contacts after approval.",
    docs: "internal Jarvis contact owner assignment workflow",
    build(action) {
      const payload = action.payload || {};
      const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
      return {
        method: "WORKFLOW",
        path: "jarvis://contacts/owner-assignment",
        body: {
          ownerName: cleanString(payload.ownerName),
          ownerId: cleanString(payload.ownerId),
          audienceType: cleanString(payload.audienceType || "tag"),
          tagName: cleanString(payload.tagName),
          contactCount: contacts.length || Number(payload.contactCount || 0),
          preview: Array.isArray(payload.preview) ? payload.preview.slice(0, 10) : [],
          approvalRequired: true,
          updates: "PUT /contacts/:contactId with assignedTo",
        },
      };
    },
    extract(data) {
      return { report: data };
    },
  }),

  opportunity_builder: actionDoc({
    method: "WORKFLOW",
    endpoint: "jarvis://opportunities/builder",
    riskLevel: "medium",
    description:
      "Create missing opportunities for a saved set of tagged contacts after approval.",
    docs: "internal Jarvis Opportunity Builder workflow",
    build(action) {
      const payload = action.payload || {};
      const contacts = Array.isArray(payload.contacts) ? payload.contacts : [];
      return {
        method: "WORKFLOW",
        path: "jarvis://opportunities/builder",
        body: {
          audienceType: cleanString(payload.audienceType || "tag"),
          tagName: cleanString(payload.tagName),
          contactCount: contacts.length || Number(payload.contactCount || 0),
          preview: Array.isArray(payload.preview) ? payload.preview.slice(0, 10) : [],
          pipelineName: cleanString(payload.pipelineName),
          pipelineId: cleanString(payload.pipelineId),
          stageName: cleanString(payload.stageName),
          stageId: cleanString(payload.stageId || payload.pipelineStageId),
          approvalRequired: true,
          checks: "GET /opportunities/search per contact",
          creates: "POST /opportunities/ for missing opportunities only",
        },
      };
    },
    extract(data) {
      return { report: data };
    },
  }),
};

function isSupportedAction(actionType) {
  return Object.prototype.hasOwnProperty.call(ACTION_DEFINITIONS, actionType);
}

function supportedActionTypes() {
  return Object.keys(ACTION_DEFINITIONS);
}

function riskMax(a, b) {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

function getActionDefinition(actionType) {
  return ACTION_DEFINITIONS[actionType] || null;
}

function buildRequestForAction(action, executionContext = {}) {
  const definition = getActionDefinition(action.actionType);
  if (!definition) {
    throw Object.assign(new Error(UNSUPPORTED_MESSAGE), { statusCode: 422 });
  }
  return definition.build(action, executionContext);
}

function plannedCallForAction(action) {
  const definition = getActionDefinition(action.actionType);
  if (!definition) {
    return {
      actionId: cleanString(action.actionId),
      actionType: cleanString(action.actionType) || "unsupported",
      supported: false,
      method: "",
      endpoint: "",
      description: cleanString(action.description),
      riskLevel: action.riskLevel || "low",
      destructive: !!action.destructive,
      reason: cleanString(action.unsupportedReason) || UNSUPPORTED_MESSAGE,
    };
  }

  let preview = null;
  try {
    preview = buildRequestForAction(action, {
      preview: true,
      actionResults: {},
    });
  } catch (error) {
    preview = {
      method: definition.method,
      path: definition.endpoint,
      body: { validationError: error.message },
    };
  }

  return {
    actionId: cleanString(action.actionId),
    actionType: cleanString(action.actionType),
    supported: true,
    method: definition.method,
    endpoint: definition.endpoint,
    requestPreview: {
      method: preview.method || definition.method,
      path: preview.path || definition.endpoint,
      query: preview.query || {},
      body: preview.body || null,
    },
    description: cleanString(action.description) || definition.description,
    riskLevel: definition.riskLevel,
    destructive: definition.destructive,
  };
}

async function executeAction(action, executionContext = {}) {
  const definition = getActionDefinition(action.actionType);
  if (!definition) {
    throw Object.assign(new Error(UNSUPPORTED_MESSAGE), { statusCode: 422 });
  }

  const requestShape = buildRequestForAction(action, executionContext);
  const result = await request(requestShape);
  const extracted = definition.extract(result.data) || {};

  return {
    actionId: cleanString(action.actionId),
    actionType: action.actionType,
    request: result.request,
    response: result.data,
    status: result.status,
    rateLimit: result.rateLimit,
    extracted,
  };
}

module.exports = {
  ACTION_DEFINITIONS,
  UNSUPPORTED_MESSAGE,
  buildRequestForAction,
  cleanList,
  cleanString,
  executeAction,
  getActionDefinition,
  isSupportedAction,
  parseJsonObjectText,
  plannedCallForAction,
  riskMax,
  supportedActionTypes,
};
