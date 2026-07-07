const fetch = require("node-fetch");
const { PLAN_SCHEMA, buildPlannerPrompt } = require("./aiCommanderGhl.prompt");

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function outputTextFromResponse(data) {
  if (data?.output_text) return String(data.output_text);
  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === "refusal" && content?.refusal) {
        const error = new Error(content.refusal);
        error.statusCode = 400;
        throw error;
      }
      if (content?.type === "output_text" && content?.text) {
        chunks.push(content.text);
      } else if (content?.text) {
        chunks.push(content.text);
      }
    }
  }
  return chunks.join("\n").trim();
}

async function generateGhlPlan(message) {
  const apiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!apiKey) {
    const error = new Error("Missing OPENAI_API_KEY");
    error.statusCode = 500;
    throw error;
  }

  const response = await fetch(OPENAI_RESPONSES_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.AI_COMMANDER_OPENAI_MODEL || "gpt-4o-mini",
      instructions: buildPlannerPrompt(),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: String(message || "").trim(),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "ghl_ai_commander_plan",
          strict: true,
          schema: PLAN_SCHEMA,
        },
      },
      max_output_tokens: 5000,
      store: false,
      temperature: 0.2,
    }),
  });

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { raw };
  }

  if (!response.ok) {
    const error = new Error(
      `OpenAI planner request failed: ${response.status} ${
        data?.error?.message || raw || ""
      }`.trim()
    );
    error.statusCode = 502;
    throw error;
  }

  const text = outputTextFromResponse(data);
  if (!text) {
    const error = new Error("OpenAI planner returned an empty plan");
    error.statusCode = 502;
    throw error;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    error.message = `OpenAI planner returned invalid JSON: ${error.message}`;
    error.statusCode = 502;
    throw error;
  }
}

module.exports = {
  generateGhlPlan,
  outputTextFromResponse,
};
