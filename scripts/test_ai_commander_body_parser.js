const express = require("express");
const http = require("http");

const servicePath = require.resolve("../src/aiCommanderGhl/aiCommanderGhl.service");
require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    createPlan: async ({ message, adminUserId }) => ({
      confirmationId: "dev-test-confirmation",
      summary: `accepted: ${message}`,
      exactPlan: [],
      objectsAffected: [],
      messagesToSendOrCreate: [],
      plannedApiActions: [],
      riskLevel: "low",
      destructive: false,
      requiresApproval: true,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      adminUserId,
    }),
    executePlan: async () => ({
      status: "executed",
      executedActions: [],
      results: [],
      errors: [],
    }),
  },
};

const controller = require("../src/aiCommanderGhl/aiCommanderGhl.controller");

function isJsonBodyParseError(err) {
  return (
    err?.type === "entity.parse.failed" ||
    (err instanceof SyntaxError &&
      err.status === 400 &&
      Object.prototype.hasOwnProperty.call(err, "body"))
  );
}

function createApp() {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use((req, _res, next) => {
    req.user = { id: "dev-admin" };
    next();
  });
  app.post("/api/admin/ai-commander/ghl/plan", controller.plan);
  app.use((err, _req, res, _next) => {
    if (isJsonBodyParseError(err)) {
      return res.status(400).json({
        message: "Invalid JSON request body",
        error: err.message,
      });
    }
    return res.status(500).json({ message: err.message });
  });
  return app;
}

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function requestJson(baseUrl, body) {
  const response = await fetch(`${baseUrl}/api/admin/ai-commander/ghl/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const data = await response.json();
  return { status: response.status, data };
}

async function main() {
  const server = await listen(createApp());
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const valid = await requestJson(
      baseUrl,
      JSON.stringify({
        message:
          "Create a test GHL contact named AI Test Contact, phone 6315991363, tag ai-test.",
      })
    );
    if (valid.status !== 200 || !valid.data.summary.includes("AI Test Contact")) {
      throw new Error(`Expected valid JSON body to be accepted, got ${valid.status}`);
    }

    const invalid = await requestJson(baseUrl, "{\n    message: bad\n}");
    if (invalid.status !== 400 || invalid.data.message !== "Invalid JSON request body") {
      throw new Error(`Expected malformed JSON to return 400, got ${invalid.status}`);
    }

    console.log("AI Commander JSON body parser dev test passed");
  } finally {
    server.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
