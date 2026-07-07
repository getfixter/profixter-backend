const { createPlan, executePlan } = require("./aiCommanderGhl.service");

function statusForError(error) {
  return Number(error?.statusCode || error?.status || 500);
}

function publicError(error, fallback) {
  return {
    message: error?.message || fallback,
  };
}

function logError(context, error, req) {
  console.error(`GHL AI Commander ${context} failed`, {
    method: req.method,
    path: req.originalUrl,
    adminUserId: req.user?.id || null,
    statusCode: statusForError(error),
    message: error?.message || String(error),
    stack: error?.stack || null,
  });
}

function requireObjectBody(req) {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    const error = new Error("Request body must be a JSON object.");
    error.statusCode = 400;
    throw error;
  }
  return req.body;
}

async function plan(req, res) {
  try {
    const body = requireObjectBody(req);
    const result = await createPlan({
      message: body.message,
      adminUserId: req.user.id,
    });
    return res.json(result);
  } catch (error) {
    logError("plan", error, req);
    return res
      .status(statusForError(error))
      .json(publicError(error, "Failed to create GHL AI plan"));
  }
}

async function execute(req, res) {
  try {
    const body = requireObjectBody(req);
    const result = await executePlan({
      confirmationId: body.confirmationId,
    });
    return res.json(result);
  } catch (error) {
    logError("execute", error, req);
    return res.status(statusForError(error)).json({
      status: "failed",
      executedActions: [],
      results: [],
      errors: [error?.message || "Failed to execute GHL AI plan"],
    });
  }
}

module.exports = {
  execute,
  plan,
};
