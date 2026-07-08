const assert = require("assert");

const {
  START_CONFIRMATION,
  buildCampaignTemplateDraft,
  looksLikeCampaignBuilderRequest,
  validateCampaignTemplateDraft,
} = require("../src/aiCommanderGhl/jarvisCampaignBuilder.service");
const {
  isSupportedAction,
  plannedCallForAction,
} = require("../src/aiCommanderGhl/ghlActions");

function testRoofingSidingTemplateConfig() {
  const template = buildCampaignTemplateDraft({
    message:
      "Create a sales campaign for Roofing/Siding Re-engagement 2026. Audience tagged Roofing/Siding, sal-roofing, or sal-siding. Test mode first 10 contacts.",
  });

  assert.strictEqual(template.campaignName, "Roofing/Siding Re-engagement 2026");
  assert.strictEqual(template.audienceDefinition.type, "ghl_tags");
  assert.deepStrictEqual(template.audienceDefinition.tags, [
    "Roofing/Siding",
    "sal-roofing",
    "sal-siding",
  ]);
  assert.strictEqual(template.audienceDefinition.limit, 10);
  assert.strictEqual(template.testMode, true);
  assert.strictEqual(template.approvalBeforeSending, true);
  assert.ok(template.messageSteps.length >= 1);
  assert.strictEqual(template.stopConditions.onReply, true);
  assert.strictEqual(template.stopConditions.onManualTakeover, true);
  assert.ok(template.replyHandlingRules.escalateWhen.includes("price"));
  assert.ok(template.replyHandlingRules.humanLikeDelay.minSeconds > 0);
  validateCampaignTemplateDraft(template);
}

function testGenericTemplateDoesNotHardcodeRoofing() {
  const template = buildCampaignTemplateDraft({
    message:
      'Create a sales campaign for contacts tagged Homeowners with "Hi {{contact.firstName}}, do you want a membership check-in?"',
  });

  assert.strictEqual(template.campaignName, "Homeowners Campaign");
  assert.strictEqual(template.audienceDefinition.type, "ghl_tags");
  assert.deepStrictEqual(template.audienceDefinition.tags, ["Homeowners"]);
  assert.strictEqual(template.messageSteps.length, 1);
  assert.ok(template.messageSteps[0].body.includes("membership check-in"));
  assert.ok(!template.outcomeTags.includes("Roofing/Siding"));
  validateCampaignTemplateDraft(template);

  const inferredAudience = buildCampaignTemplateDraft({
    message: "Create a campaign for homeowners with a seasonal check-in.",
  });
  assert.deepStrictEqual(inferredAudience.audienceDefinition.tags, ["homeowners"]);
  validateCampaignTemplateDraft(inferredAudience);
}

function testUploadedCsvAudience() {
  const template = buildCampaignTemplateDraft({
    message: "Create a sales campaign for this uploaded CSV with a simple follow-up.",
    uploadBatchId: "batch_123",
    files: [
      {
        uploadId: "file_123",
        originalName: "leads.csv",
        extension: "csv",
        tempRef: "local:tmp/leads.csv",
      },
    ],
  });

  assert.strictEqual(template.audienceDefinition.type, "uploaded_csv");
  assert.strictEqual(template.audienceDefinition.uploadBatchId, "batch_123");
  assert.strictEqual(template.audienceDefinition.files.length, 1);
  validateCampaignTemplateDraft(template);
}

function testPlanPreviewAction() {
  assert.strictEqual(isSupportedAction("jarvis_campaign_template_create"), true);
  const template = buildCampaignTemplateDraft({
    message: "Create a campaign for contacts tagged Homeowners.",
  });
  const preview = plannedCallForAction({
    actionId: "create_template",
    actionType: "jarvis_campaign_template_create",
    supported: true,
    payload: {
      campaignTemplateJson: JSON.stringify(template),
    },
  });

  assert.strictEqual(preview.method, "INTERNAL");
  assert.strictEqual(preview.endpoint, "jarvis://campaigns/templates");
  assert.strictEqual(preview.requestPreview.body.campaignName, template.campaignName);
  assert.strictEqual(preview.requestPreview.body.startsCampaign, false);
  assert.strictEqual(preview.requestPreview.body.approvalBeforeSending, true);
}

function testValidationGuards() {
  assert.strictEqual(START_CONFIRMATION, "START CAMPAIGN");
  assert.strictEqual(
    looksLikeCampaignBuilderRequest("Create a sales campaign for homeowners"),
    true
  );
  assert.strictEqual(looksLikeCampaignBuilderRequest("How many campaigns exist?"), false);

  assert.throws(
    () =>
      validateCampaignTemplateDraft({
        campaignName: "Broken",
        audienceDefinition: { type: "ghl_tags", tags: [] },
        messageSteps: [],
      }),
    /At least one message step is required/
  );
}

function main() {
  testRoofingSidingTemplateConfig();
  testGenericTemplateDoesNotHardcodeRoofing();
  testUploadedCsvAudience();
  testPlanPreviewAction();
  testValidationGuards();
  console.log("Jarvis campaign builder tests passed.");
}

main();
