# GHL AI Commander Test Instructions

Do not deploy during this test. Run it only against a GHL location intended for testing.

## Required Environment

Set these backend environment variables:

```bash
OPENAI_API_KEY=
GHL_API_TOKEN=
GHL_LOCATION_ID=
AI_COMMANDER_GHL_ENABLED=true
```

Use an admin JWT for the requests below. The route is protected by the existing admin permission middleware.

## 1. Plan Only

```bash
curl -X POST http://localhost:5000/api/admin/ai-commander/ghl/plan \
  -H "Authorization: Bearer ADMIN_JWT_HERE" \
  -H "Content-Type: application/json" \
  -d "{\"message\":\"Create a test GHL contact named AI Test Contact, phone 6310000000, tag ai-test.\"}"
```

Expected result:

- Response includes `confirmationId`.
- Response includes a `create_contact` planned API action.
- Response shows contact name `AI Test Contact`, phone `+16310000000`, and tag `ai-test`.
- Nothing is created in GHL yet.

## 2. Execute After Approval

Use the returned `confirmationId` within 30 minutes:

```bash
curl -X POST http://localhost:5000/api/admin/ai-commander/ghl/execute \
  -H "Authorization: Bearer ADMIN_JWT_HERE" \
  -H "Content-Type: application/json" \
  -d "{\"confirmationId\":\"PASTE_CONFIRMATION_ID_HERE\"}"
```

Expected result:

- Response status is `executed`.
- `executedActions` includes the GHL contact creation request.
- `results` includes the GHL response and any returned contact ID.

## 3. Verify In GHL

Open the configured GHL sub-account and search Contacts for:

- Name: `AI Test Contact`
- Phone: `6310000000` or `+16310000000`
- Tag: `ai-test`

The audit record is saved in MongoDB in the `aicommanderghlaudits` collection.
