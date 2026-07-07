const { createPlan, executePlan } = require("./aiCommanderGhl.service");

function statusForError(error) {
  return Number(error?.statusCode || error?.status || 500);
}

function publicError(error, fallback) {
  return {
    message: error?.message || fallback,
  };
}

async function plan(req, res) {
  try {
    const result = await createPlan({
      message: req.body?.message,
      adminUserId: req.user.id,
    });
    return res.json(result);
  } catch (error) {
    console.error("GHL AI Commander plan failed:", error.message);
    return res
      .status(statusForError(error))
      .json(publicError(error, "Failed to create GHL AI plan"));
  }
}

async function execute(req, res) {
  try {
    const result = await executePlan({
      confirmationId: req.body?.confirmationId,
    });
    return res.json(result);
  } catch (error) {
    console.error("GHL AI Commander execute failed:", error.message);
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
