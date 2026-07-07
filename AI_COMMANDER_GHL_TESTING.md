# GHL AI Commander Test Instructions

Do not deploy during this test. Run it only against a GHL location intended for testing.

## Required Environment

Set these backend environment variables:

```bash
OPENAI_API_KEY=
GHL_AI_COMMANDER_TOKEN=
GHL_LOCATION_ID=
AI_COMMANDER_GHL_ENABLED=true
```

Use an admin JWT for the requests below. The route is protected by the existing admin permission middleware.

## 1. Plan Only

Windows PowerShell:

```powershell
$body = @{
  message = "Create a test GHL contact named AI Test Contact, phone 6315991363, tag ai-test."
} | ConvertTo-Json

curl.exe -X POST "http://localhost:5000/api/admin/ai-commander/ghl/plan" `
  -H "Authorization: Bearer ADMIN_JWT_HERE" `
  -H "Content-Type: application/json" `
  --data-raw $body
```

macOS/Linux/Git Bash:

```bash
curl -X POST http://localhost:5000/api/admin/ai-commander/ghl/plan \
  -H "Authorization: Bearer ADMIN_JWT_HERE" \
  -H "Content-Type: application/json" \
  --data-raw '{"message":"Create a test GHL contact named AI Test Contact, phone 6315991363, tag ai-test."}'
```

Expected result:

- Response includes `confirmationId`.
- Response includes a `create_contact` planned API action.
- Response shows contact name `AI Test Contact`, phone `+16315991363`, and tag `ai-test`.
- Nothing is created in GHL yet.

## 2. Execute After Approval

Use the returned `confirmationId` within 30 minutes:

Windows PowerShell:

```powershell
$body = @{
  confirmationId = "PASTE_CONFIRMATION_ID_HERE"
} | ConvertTo-Json

curl.exe -X POST "http://localhost:5000/api/admin/ai-commander/ghl/execute" `
  -H "Authorization: Bearer ADMIN_JWT_HERE" `
  -H "Content-Type: application/json" `
  --data-raw $body
```

macOS/Linux/Git Bash:

```bash
curl -X POST http://localhost:5000/api/admin/ai-commander/ghl/execute \
  -H "Authorization: Bearer ADMIN_JWT_HERE" \
  -H "Content-Type: application/json" \
  --data-raw '{"confirmationId":"PASTE_CONFIRMATION_ID_HERE"}'
```

Expected result:

- Response status is `executed`.
- `executedActions` includes the GHL contact creation request.
- `results` includes the GHL response and any returned contact ID.

## 3. Verify In GHL

Open the configured GHL sub-account and search Contacts for:

- Name: `AI Test Contact`
- Phone: `6315991363` or `+16315991363`
- Tag: `ai-test`

The audit record is saved in MongoDB in the `aicommanderghlaudits` collection.

## Dev Body Parser Check

Run this without OpenAI, GHL, MongoDB, or an admin JWT:

```powershell
npm run test:ai-commander-body
```

It verifies that the plan controller accepts a normal `application/json` object body and that malformed JSON returns `400 Invalid JSON request body`.
