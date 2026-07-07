# Roofing Sales Agent v1 Test Instructions

Do not deploy during this test. Run it only against a GHL location intended for testing.

## Required Environment

```bash
OPENAI_API_KEY=
GHL_AI_COMMANDER_TOKEN=
GHL_LOCATION_ID=
JARVIS_GHL_WEBHOOK_SECRET=
JARVIS_ROOFING_AGENT_ENABLED=false
JARVIS_ROOFING_AGENT_MODE=suggest_only
JARVIS_ADMIN_ALERT_EMAIL=
JARVIS_ADMIN_ALERT_PHONE=
```

Optional GHL execution settings for callback opportunity/task ownership:

```bash
JARVIS_ROOFING_AGENT_PIPELINE_ID=
JARVIS_ROOFING_AGENT_PIPELINE_STAGE_ID=
JARVIS_ROOFING_AGENT_ASSIGNED_TO=
```

## Local No-Network Checks

```powershell
npm run test:roofing-sales-agent
```

This verifies webhook parsing, callback task due-date parsing, blocked auto-reply classes, and planned callback actions without OpenAI, MongoDB, or GHL.

## Simulate Endpoint

The simulate route is admin-only and does not send SMS or write GHL actions.

```powershell
$body = @{
  contactName = "John"
  phone = "6315550100"
  incomingMessage = "maybe tomorrow after 5"
  conversationHistory = @()
} | ConvertTo-Json

curl.exe -X POST "http://localhost:5000/api/admin/jarvis/roofing-agent/simulate" `
  -H "Authorization: Bearer ADMIN_JWT_HERE" `
  -H "Content-Type: application/json" `
  --data-raw $body
```

Expected result:

- `classification` is one of the allowed Roofing Sales Agent categories.
- `recommendedReply` is short SMS copy.
- `actionsPlanned` shows what would be stored or sent.
- No SMS is sent.

## Webhook Endpoint

Keep `JARVIS_ROOFING_AGENT_ENABLED=false` first so the inbound message is stored only.

```powershell
$body = @{
  contactId = "GHL_CONTACT_ID"
  contactName = "John"
  phone = "6315550100"
  message = "tomorrow after 5"
  conversationId = "GHL_CONVERSATION_ID"
} | ConvertTo-Json

curl.exe -X POST "http://localhost:5000/api/jarvis/roofing-agent/ghl-webhook" `
  -H "x-jarvis-ghl-webhook-secret: YOUR_SECRET" `
  -H "Content-Type: application/json" `
  --data-raw $body
```

Then enable suggestion mode:

```bash
JARVIS_ROOFING_AGENT_ENABLED=true
JARVIS_ROOFING_AGENT_MODE=suggest_only
```

Expected result:

- The backend classifies and stores the suggested reply.
- It does not send SMS.
- It does not execute GHL mutations in `suggest_only`.

Only after reviewing behavior, enable safe one-to-one auto replies:

```bash
JARVIS_ROOFING_AGENT_MODE=auto_reply_safe
```

Safety expectations:

- No bulk SMS exists in v1.
- No campaign sender exists in v1.
- SMS is never sent for `human_takeover`, `angry_or_complaint`, `stop_unsubscribe`, `wrong_number`, or `not_interested`.
- Callback opportunity creation remains unsupported until `JARVIS_ROOFING_AGENT_PIPELINE_ID` is set.
