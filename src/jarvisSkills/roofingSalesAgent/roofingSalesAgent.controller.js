const service = require("./roofingSalesAgent.service");
const { verifyWebhookSecret } = require("./roofingSalesAgent.webhook");

function statusFromError(error) {
  const status = Number(error?.statusCode || error?.status || 500);
  return status >= 400 && status < 600 ? status : 500;
}

function publicError(error, fallback) {
  return {
    message: error?.message || fallback,
  };
}

async function simulate(req, res) {
  try {
    const result = await service.simulateRoofingSalesAgent(req.body || {});
    return res.json(result);
  } catch (error) {
    console.error("Roofing Sales Agent simulate failed", {
      message: error?.message || "",
      statusCode: statusFromError(error),
    });
    return res
      .status(statusFromError(error))
      .json(publicError(error, "Failed to simulate Roofing Sales Agent"));
  }
}

async function ghlWebhook(req, res) {
  try {
    verifyWebhookSecret(req);
    const result = await service.handleGhlWebhook(req.body || {});
    return res.status(result.ignored ? 202 : 200).json(result);
  } catch (error) {
    console.error("Roofing Sales Agent GHL webhook failed", {
      message: error?.message || "",
      statusCode: statusFromError(error),
    });
    return res
      .status(statusFromError(error))
      .json(publicError(error, "Failed to process Roofing Sales Agent webhook"));
  }
}

module.exports = {
  ghlWebhook,
  simulate,
};
