# Sign-in providers: setup and switch-on

Registration 2.0 ships with every provider **off** until it is configured. A
button only appears on the site once its settings exist, so nothing half-set-up
is ever shown to customers. Never paste secrets into chat, email or code; set
them only in Elastic Beanstalk (backend) and Vercel (frontend).

Verify each provider on a **Vercel Preview deployment first** (set the variables
for the Preview environment only), then repeat for Production.

## 1. Phone codes (Twilio)

Codes go out through **Twilio Verify** when `TWILIO_VERIFY_SERVICE_SID` is set,
otherwise through the existing Messaging Service.

Our A2P campaign is registered as **LOW_VOLUME**. Sending sign-in codes through
it is only compliant if the campaign covers verification codes, so the
recommended path is Verify:

1. Twilio Console → Verify → Services → **Create new**.
   - Friendly name: `Profixter` (customers see it in the text).
   - Code length: **6**. Channels: SMS only.
   - Fraud Guard: **on** (SMS pumping protection).
   - Geo permissions: **United States** only (US-only is our policy).
2. Copy the Service SID (starts `VA…`).
3. Elastic Beanstalk → Handyman-v2-env → Configuration → Environment properties:
   - `TWILIO_VERIFY_SERVICE_SID` = the `VA…` SID
   - `SMS_OTP_ENABLED` = `true` (only when ready to go live)
   - optional `OTP_SMS_DAILY_CAP` (default 300 codes/day site-wide)

Alternative without Verify: ask Twilio to add verification codes to the
campaign (new sample messages, carrier re-review), then set only
`SMS_OTP_ENABLED=true`. This path also gives Chrome on Android one-tap code
reading (WebOTP), because our own message ends with `@www.profixter.com #123456`.
With Verify, iOS autofill and Android keyboard suggestions work; Chrome's
automatic read needs Twilio to enable a domain-bound template on the service.

## 2. Google

1. Google Cloud Console → APIs & Services → **OAuth consent screen**: External,
   app name Profixter, support email, logo, links to /privacy and /terms;
   scopes `openid`, `email`, `profile` only. Publish the app.
2. Credentials → **Create OAuth client ID** → Web application.
   - Authorized JavaScript origins: `https://www.profixter.com`,
     `https://profixter.com`, and your Vercel preview origin for testing.
   - No redirect URI is needed (ID-token flow).
3. Set the client id (ends `.apps.googleusercontent.com`; it is public, not a secret):
   - Elastic Beanstalk: `GOOGLE_CLIENT_ID`
   - Vercel: `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (same value)

One Tap and FedCM need nothing extra; they use the same client id.

## 3. Apple

Requires an Apple Developer Program membership.

1. Certificates, Identifiers & Profiles → Identifiers → **App IDs**: create one
   (e.g. `com.profixter.app`) with **Sign in with Apple** enabled.
2. Identifiers → **Services IDs**: create `com.profixter.web`, enable Sign in
   with Apple, Configure:
   - Primary App ID: the App ID above
   - Domains: `www.profixter.com` (and the Vercel preview domain for testing)
   - Return URLs: `https://www.profixter.com/signup`
3. **Hide My Email**: Services → *Sign in with Apple for Email Communication* →
   register the domain/address Profixter sends from (the SES sender), and keep
   its SPF/DKIM valid. Without this, email to relay addresses bounces.
4. Set:
   - Elastic Beanstalk: `APPLE_CLIENT_IDS` = `com.profixter.web`
   - Vercel: `NEXT_PUBLIC_APPLE_CLIENT_ID` = `com.profixter.web`,
     `NEXT_PUBLIC_APPLE_REDIRECT_URI` = `https://www.profixter.com/signup`

No Apple private key is needed: we only verify Apple's signed identity token.

## 4. Email codes

Uses the existing SES sender. Nothing to configure.

## Verify before switching on

```
node scripts/check_auth_providers.js
node scripts/check_auth_providers.js --send-test-code +1YOURNUMBER
```

The first is read-only. The second sends **one** real code to your own phone
through the exact customer path. Then, on the Preview deployment, sign up once
each with phone, email, Google and Apple, and sign in once with your existing
password. Only then set the Production variables.
