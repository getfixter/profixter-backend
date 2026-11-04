/**
 * The public surface an A2P 10DLC reviewer sees, pinned.
 *
 * WHAT THIS EXISTS TO STOP
 *
 * ProFixter has been rejected four times. Two of those rejections - 30896
 * (opt-in not verifiable) and 30923 (consent required for service) - were fixed
 * in the consent model and are guarded by test_sms_consent_mechanics.js. This
 * file guards the other half, which is everything a reviewer can see without
 * logging in: whether the sign-up page links the documents it has to link,
 * whether a crawler is allowed to fetch it at all, whether the legal pages
 * still describe the system we actually built, and whether the evidence page
 * has quietly grown a checkbox and become a second opt-in method.
 *
 * Each of those failed at least once by being invisible rather than by being
 * wrong. A Disallow line, a link that only appeared on step 4, one sentence in
 * a legal page describing a text-in opt-in the code does not implement - none
 * of it looked like a bug in review, and all of it is the kind of thing that
 * comes back when someone tidies a file months later.
 *
 * REGISTRATION 2.0 (2026-10-28). The registered campaign says text consent is
 * OPTIONAL and is not collected at sign-up. Sign-in codes are sent through
 * Twilio Verify, outside the campaign, and a code the person requests needs no
 * checkbox - so the sign-up page now has NO checkboxes, only one line under
 * the button ("terms.continue.v1"). Service texts moved to one optional,
 * unticked box at the booking step ("sms_service.booking.v1") and stay in
 * account settings; marketing texts are offered in account settings only. The
 * cases below that pinned the old three-box form were rewritten to pin this
 * flow with the same strictness: no SMS control and no marketing wording at
 * sign-up, the exact disclosure line and its three links, the booking box
 * unticked and service-only and saved only after a booking succeeds, the
 * settings boxes separate and unticked, and public pages that say so.
 *
 * 2026-11-03. The public pages said consent was collected in exactly two
 * places and that there was no verbal opt-in. By then neither was true: a guest
 * requesting a Free Visit agrees by pressing the button under a disclosure line
 * (no account, no checkbox, that one visit only), and staff record a caller's
 * yes or no for texts about their visits. The booking box became
 * "sms_service.booking.v2" with its documents linked. The cases that pinned the
 * two-place claim now pin the five places, each quoted exactly, and forbid the
 * old claims coming back; the guest line, the booking box's links and the
 * settings documents line are pinned to the screens that show them.
 *
 * 2026-11-03 (later): the owner asked for one optional, unticked offers box on
 * the "Add your mobile number" screen (ContactCompletion), recorded only after
 * the code verifies the number ("sms_marketing.phone_verify.v1"), and - when a
 * number is changed - an optional, unticked visit-texts box
 * ("sms_service.phone_change.v1"). The six places are pinned, each box's words
 * exactly; the phone sign-up screen still has no box and no marketing wording.
 *
 * These cases need the sibling FrontEnd checkout and skip loudly without it,
 * the same arrangement test_sms_consent_mechanics.js uses and for the same
 * reason: a compliance assertion that silently stopped running would be worse
 * than one that was never written.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const FRONTEND = path.join(__dirname, "..", "..", "FrontEnd");
const SIGNUP_PAGE = path.join(FRONTEND, "app", "(auth)", "signup", "page.tsx");
const FRONTEND_PRESENT = fs.existsSync(SIGNUP_PAGE);

const P = {
  signup: SIGNUP_PAGE,
  signupLayout: path.join(FRONTEND, "app", "(auth)", "signup", "layout.tsx"),
  authLayout: path.join(FRONTEND, "app", "(auth)", "layout.tsx"),
  accountLayout: path.join(FRONTEND, "app", "account", "layout.tsx"),
  robots: path.join(FRONTEND, "app", "robots.ts"),
  seo: path.join(FRONTEND, "lib", "seo.ts"),
  architecture: path.join(FRONTEND, "lib", "site-architecture.ts"),
  footer: path.join(FRONTEND, "app", "components", "sections", "Footer.tsx"),
  about: path.join(FRONTEND, "app", "about", "page.tsx"),
  privacy: path.join(FRONTEND, "app", "privacy", "page.tsx"),
  terms: path.join(FRONTEND, "app", "terms", "page.tsx"),
  consent: path.join(FRONTEND, "app", "communication-consent", "page.tsx"),
  evidence: path.join(FRONTEND, "app", "sms-consent-example", "page.tsx"),
  popup: path.join(FRONTEND, "app", "components", "promotion", "VisitorPromotionPopup.tsx"),
  authSteps: path.join(FRONTEND, "app", "components", "auth", "AuthSteps.tsx"),
  contact: path.join(FRONTEND, "app", "components", "auth", "ContactCompletion.tsx"),
  auth2: path.join(FRONTEND, "lib", "auth2.ts"),
  optIn: path.join(FRONTEND, "app", "components", "booking", "ServiceTextsOptIn.tsx"),
  freeVisit: path.join(FRONTEND, "app", "components", "booking", "FreeVisitBooker.tsx"),
  memberBooking: path.join(FRONTEND, "app", "components", "sections", "BookingSection.tsx"),
  oneTime: path.join(FRONTEND, "app", "book", "page.tsx"),
  fullDay: path.join(FRONTEND, "app", "components", "booking", "FullDayVisitPanel.tsx"),
  smsPrefs: path.join(FRONTEND, "app", "components", "account", "SmsPreferences.tsx"),
  handyman: path.join(FRONTEND, "app", "components", "booking4", "HandymanBooker.tsx"),
  guestForm: path.join(FRONTEND, "app", "components", "booking4", "FreeVisitForm.tsx"),
  guestRoute: path.join(__dirname, "..", "routes", "freeVisitRequests.js"),
};

/** The guest Free Visit line the server accepts as current, read from the route that stores it. */
function serverGuestLine() {
  const src = readSource(P.guestRoute);
  const m = src.match(/const CONTACT_CONSENT_TEXT =\s*"([^"]+)";/);
  if (!m) throw new Error("routes/freeVisitRequests.js no longer declares CONTACT_CONSENT_TEXT as one string");
  return m[1];
}

/** The registered consent wordings, from the backend that records them. */
function VERSIONS() {
  return require(path.join(__dirname, "..", "utils", "consent", "consentText.js")).VERSIONS;
}

/** The on-screen sentence a version quotes: its first "double-quoted" run. */
function registeredQuote(version) {
  const text = VERSIONS()[version].text;
  const m = text.match(/"([^"]+)"/);
  if (!m) throw new Error(`${version} quotes no on-screen wording`);
  return m[1];
}

/** Source with line endings normalised - see the note in the consent suite. */
function readSource(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

/**
 * The same source as one long line, for asserting on PROSE.
 *
 * Sentences in JSX are wrapped by the formatter, and the wrap point moves
 * whenever a line grows or a class name changes. Matching a sentence against
 * raw source therefore produces a test that fails when somebody reformats the
 * file and passes when somebody deletes half the paragraph - precisely backwards.
 * Collapsing whitespace first asks the question we actually mean: is this
 * sentence still on the page?
 *
 * JSX comments go too, so a requirement quoted in a code comment can never be
 * mistaken for the requirement being met.
 */
function readText(file) {
  return readSource(file)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\s+/g, " ");
}

/**
 * Source with comments removed, for asserting on STRUCTURE.
 *
 * Index arithmetic over raw source is fooled by prose. This file's first
 * attempt at the fieldset assertions failed because the component explains, in
 * a comment, that the consent panel used to sit after "</form>" - and
 * indexOf("</form>") duly found the sentence rather than the tag. Comments
 * describe the code; they are not the code, and structural questions must be
 * asked of the markup alone.
 */
function readMarkup(file) {
  return readSource(file)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * The character ranges covered by each {step === N ? ... : null} branch, each
 * tagged with the step it belongs to.
 *
 * Anything rendered inside one of these only exists on that step, which is the
 * whole point of the checks below: the owner's design puts the mobile number
 * and both consent boxes on the final step and nowhere earlier, and these
 * ranges are how a test can tell "step 4" from "step 1" in a source file.
 *
 * The branches do not nest, so each one runs to its own matching brace.
 */
function stepBranchRanges(markup) {
  const ranges = [];
  const opener = /\{step === ([0-9]) \?/g;
  let m;
  while ((m = opener.exec(markup))) {
    /*
     * Brace matching, not "the next ) : null}".
     *
     * Every inner conditional - {fieldErrors.phone ? (...) : null} - ends with
     * the same nine characters, so searching for the nearest one closes the
     * step branch at its first child and reports everything after it as
     * top-level. Counting braces from the opener finds the real end.
     */
    let depth = 0;
    let end = -1;
    for (let i = m.index; i < markup.length; i += 1) {
      if (markup[i] === "{") depth += 1;
      else if (markup[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end > -1) ranges.push([m.index, end, Number(m[1])]);
  }
  return ranges;
}

function insideAnyStepBranch(markup, index) {
  return stepBranchRanges(markup).some(([a, b]) => index > a && index < b);
}

/** Which step renders the thing at this index, or null if it renders on all of them. */
function stepOf(markup, index) {
  const hit = stepBranchRanges(markup).find(([a, b]) => index > a && index < b);
  return hit ? hit[2] : null;
}

/** The last step of the wizard, read from the source rather than hard-coded. */
function finalStep(markup) {
  return Math.max(...stepBranchRanges(markup).map(([, , n]) => n));
}

/** The <p id="..."> element with this id, from its opening tag to its </p>. */
function disclosureElement(markup, id) {
  const start = markup.indexOf(`<p id="${id}"`);
  assert.ok(start > -1, `no <p id="${id}"> found`);
  const end = markup.indexOf("</p>", start);
  assert.ok(end > start, `<p id="${id}"> is not closed`);
  return markup.slice(start, end + 4);
}

/**
 * What JSX renders as text, near enough to compare a sentence exactly: tags
 * removed, {" "} as a space, and JSX's own whitespace rule - inside a text run
 * that spans lines, each line is trimmed and empty lines vanish - so a
 * formatter re-wrapping the sentence never changes the answer.
 */
function renderedText(markup) {
  const chunks = markup
    .replace(/\{" "\}/g, "\u0000 \u0000")
    .replace(/<[^>]*>/g, "\u0000")
    .split("\u0000")
    .map((chunk) => {
      if (!chunk.includes("\n")) return chunk;
      /*
       * JSX's own rule (Babel cleanJSXElementLiteralChild): every line but the
       * first loses its leading whitespace, every line but the last its
       * trailing whitespace, and empty lines vanish. So "</span> (signed in),"
       * keeps its space and "</span>\n  text" does not - as on screen.
       */
      const lines = chunk.split("\n");
      const kept = lines
        .map((l, i) => {
          let s = l.replace(/\t/g, " ");
          if (i > 0) s = s.replace(/^ +/, "");
          if (i < lines.length - 1) s = s.replace(/ +$/, "");
          return s;
        })
        .filter(Boolean);
      return kept.join(" ");
    });
  return chunks
    .join("")
    .replace(/&amp;/g, "&")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&rsquo;|&apos;/g, "'")
    .replace(/&mdash;/g, "-")
    .replace(/[ \t]+/g, " ")
    .trim();
}

let passed = 0;
const failures = [];
const skipped = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error?.message || error}`);
  }
}

async function frontendTest(name, fn) {
  if (!FRONTEND_PRESENT) {
    skipped.push(name);
    console.log(`  SKIP  ${name}`);
    console.log(`        no FrontEnd checkout beside this repo; run locally to cover it`);
    return;
  }
  await test(name, fn);
}

function section(title) {
  console.log(`\n${title}`);
}

async function main() {
  /* ==================================================================== */
  section("A reviewer can reach the opt-in page");

  await frontendTest("robots.txt no longer tells crawlers to skip /signup", () => {
    const src = readSource(P.robots);
    /*
     * The ARRAY, not a slice of the file.
     *
     * This used to read everything between the first "disallow" and the first
     * "sitemap" in the source, which meant a comment mentioning either word
     * silently redefined what the test was looking at - and a comment did
     * exactly that. Parse the literal instead, so the assertion is about the
     * rules and not about the prose around them.
     */
    const literal = src.slice(src.indexOf("disallow: ["));
    const rules = literal
      .slice(0, literal.indexOf("]"))
      .split(",")
      .map((line) => (line.match(/"([^"]+)"/) || [])[1])
      .filter(Boolean);

    assert.ok(rules.length > 0, "could not parse the disallow list");
    assert.ok(
      !rules.includes("/signup"),
      "Disallow: /signup would stop a vetting crawler fetching the page where consent is collected"
    );

    /*
     * The genuinely internal surfaces stay shut. /account is deliberately NOT
     * in this list any more: it is kept out of the index by noindex, which is
     * asserted below, and Disallow was preventing Google from ever reading
     * that noindex - so the page could still be listed while Search Console
     * reported it as blocked. What protects the data there is a session, not a
     * robots rule. /admin and /api have no such header and stay blocked.
     */
    for (const stillBlocked of ["/admin", "/api"]) {
      assert.ok(rules.includes(stillBlocked), `${stillBlocked} must remain disallowed`);
    }
  });

  await frontendTest("the pages taken out of robots.txt are held back by noindex instead", () => {
    for (const layout of [P.authLayout, P.accountLayout]) {
      const src = readSource(layout);
      assert.ok(
        /robots:\s*\{[^}]*index:\s*false/s.test(src),
        `${layout} must declare index: false, since robots.txt no longer blocks it`
      );
      assert.ok(
        /follow:\s*false/.test(src),
        `${layout} must declare follow: false`
      );
    }
  });

  await frontendTest("/signup overrides the (auth) noindex", () => {
    const src = readSource(P.signupLayout);
    assert.ok(/robots:\s*\{[^}]*index:\s*true/s.test(src), "signup must declare index: true");
    assert.ok(/follow:\s*true/.test(src), "signup must declare follow: true");
  });

  await frontendTest("/signup and the evidence page are in the sitemap", () => {
    const src = readSource(P.seo);
    assert.ok(src.includes('path: "/signup"'), "/signup belongs in the sitemap");
    assert.ok(
      src.includes('path: "/sms-consent-example"'),
      "the evidence page belongs in the sitemap"
    );
  });

  /* ==================================================================== */
  section("The sign-up page asks for no SMS consent, and says so in one line");

  await frontendTest("every document the line has to carry is linked from the phone step, in a new tab", () => {
    /*
     * Registration 2.0. The disclosure that used to be spread over three
     * checkbox rows is now one sentence under "Text me a code", and its three
     * links are the whole route to the documents: Terms, Privacy Policy, and
     * the SMS Terms (through "verification text"). Each must be on the phone
     * step itself, and each must open in a new tab so reading it never loses
     * the number typed above.
     */
    const markup = readMarkup(P.signup);
    const line = disclosureElement(markup, "terms-continue");
    for (const href of ["/terms", "/privacy", "/communication-consent"]) {
      const link = new RegExp(`<Link href="${href}" target="_blank" rel="noopener noreferrer"`);
      assert.ok(link.test(line), `${href} must be linked from the disclosure line and open in a new tab`);
    }
    assert.strictEqual(stepOf(markup, markup.indexOf('id="terms-continue"')), 2, "the line must be on the phone step");
  });

  await frontendTest("the sign-up page contains no SMS consent control at all", () => {
    /*
     * THE INVARIANT OF THE REGISTERED FLOW. The campaign registers text consent
     * as OPTIONAL and collected at the booking step and in account settings.
     * A checkbox on this page - any checkbox - would be a third, unregistered
     * place, and a required one would be the 30923 pattern again. The code
     * this screen sends is a one-time text the person requests, delivered by
     * Twilio Verify outside the campaign; it needs no box.
     */
    for (const file of [P.signup, P.authSteps]) {
      const markup = readMarkup(file);
      assert.ok(!/type="checkbox"/.test(markup), `${path.basename(file)} must not render a checkbox`);
      for (const id of ["sms-service-consent", "sms-marketing-consent", "agree-terms", "contact-sms-service", "contact-sms-marketing"]) {
        assert.ok(!markup.includes(`id="${id}"`), `${path.basename(file)} still renders ${id}`);
      }
      assert.ok(
        !/smsTransactionalConsent|smsMarketingConsent|setAgreeTerms|ConsentRow|ConsentCheckbox|ContactConsent/.test(markup),
        `${path.basename(file)} still carries sign-up consent state or controls`
      );
    }
    /*
     * The mobile-number screen: one checkbox component, used for exactly the
     * two registered boxes, both starting unticked and never pre-ticked.
     */
    const contact = readMarkup(P.contact);
    assert.strictEqual((contact.match(/type="checkbox"/g) || []).length, 1, "ContactCompletion renders checkboxes through one component only");
    assert.ok(contact.includes('id="contact-sms-offers"') && contact.includes('id="contact-sms-visits"'), "the two boxes keep their ids");
    assert.ok(/const \[offers, setOffers\] = useState\(false\)/.test(contact), "the offers box starts unticked");
    assert.ok(/const \[visitTexts, setVisitTexts\] = useState\(false\)/.test(contact), "the visit-texts box starts unticked");
    assert.ok(!/defaultChecked|checked=\{true\}/.test(contact), "no box may be pre-ticked");
    for (const id of ["sms-service-consent", "sms-marketing-consent", "agree-terms", "contact-sms-service", "contact-sms-marketing"]) {
      assert.ok(!contact.includes(`id="${id}"`), `ContactCompletion still renders ${id}`);
    }
    assert.ok(!/smsTransactionalConsent|smsMarketingConsent|setAgreeTerms|ConsentRow|ConsentCheckbox|ContactConsent/.test(contact), "no old sign-up consent controls");
  });

  await frontendTest("the mobile-number screen's two boxes show the registered words exactly", () => {
    const src = readSource(P.contact);
    // Each version quotes the box label first and its disclosure line last (the screen's name sits between).
    const quotes = (version) => {
      const all = [...VERSIONS()[version].text.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      return [all[0], all[all.length - 1]];
    };
    const [offersLabel, offersDetails] = quotes("sms_marketing.phone_verify.v1");
    const [visitsLabel, visitsDetails] = quotes("sms_service.phone_change.v1");
    assert.ok(src.includes(`const OFFERS_LABEL = "${offersLabel}";`), "the offers label differs from sms_marketing.phone_verify.v1");
    assert.ok(src.includes(`const OFFERS_DETAILS = "${offersDetails}";`), "the offers line differs from sms_marketing.phone_verify.v1");
    assert.ok(src.includes(`const VISITS_LABEL = "${visitsLabel}";`), "the visit-texts label differs from sms_service.phone_change.v1");
    assert.ok(src.includes(`const VISITS_DETAILS = "${visitsDetails}";`), "the visit-texts line differs from sms_service.phone_change.v1");
    assert.ok(/termsHash="marketing"/.test(src) && /termsHash="service-texts"/.test(src), "each box links its own section of the SMS Terms");
    assert.ok(/href="\/privacy"/.test(src), "each box links the Privacy Policy");
    // Sent with the code, never with the request for one.
    assert.ok(/smsOptIn: \{ marketing: showOffers && offers, service: showVisitTexts && visitTexts \}/.test(src), "only what was shown and ticked is sent");
  });

  await frontendTest("the phone step is minimal: heading, number, button, the one line", () => {
    const markup = readMarkup(P.signup);
    const ranges = stepBranchRanges(markup).filter(([, , n]) => n === 2);
    assert.strictEqual(ranges.length, 1, "exactly one phone-step branch");
    const [a, b] = ranges[0];
    const branch = markup.slice(a, b);
    assert.strictEqual((branch.match(/<form\b/g) || []).length, 1, "one form");
    assert.strictEqual((branch.match(/<input\b/g) || []).length, 1, "one input: the number");
    assert.ok(branch.includes('id="phone"'), "the input is the phone field");
    assert.strictEqual((branch.match(/<p\b/g) || []).length - (branch.match(/className="auth-error/g) || []).length, 1,
      "apart from error messages, the only paragraph is the disclosure line");
    const button = branch.indexOf("Text me a code");
    const line = branch.indexOf('id="terms-continue"');
    assert.ok(button > -1 && line > button, "the line sits under the Text me a code button");
    assert.ok(line < branch.indexOf("</form>"), "and inside the same form");
  });

  await frontendTest("there is exactly one phone input on the page", () => {
    /*
     * One field, so the number verified and the number on the account are the
     * same number by construction rather than by synchronisation.
     */
    const src = readSource(P.signup);
    assert.strictEqual(
      (src.match(/id="phone"/g) || []).length,
      1,
      "a second phone input would make the verified number ambiguous"
    );
    assert.strictEqual((src.match(/type="tel"/g) || []).length, 1);
  });

  await frontendTest("the line is the registered wording, word for word, on both phone screens", () => {
    /*
     * BackEnd utils/consent/consentText.js "terms.continue.v1" is what every
     * new account's termsVersion names. The screen must say exactly that, or
     * the record answers "agreed to WHAT" with a sentence nobody saw.
     */
    const expected = registeredQuote("terms.continue.v1");
    assert.strictEqual(
      expected,
      "By continuing, you agree to the Terms and Privacy Policy and to receive a one-time verification text. Msg & data rates may apply.",
      "the registered wording itself changed; re-approve it before updating this test"
    );
    for (const file of [P.signup, P.contact]) {
      const markup = readMarkup(file);
      const shown = renderedText(disclosureElement(markup, file === P.signup ? "terms-continue" : "contact-terms-continue"));
      assert.strictEqual(shown, expected, `${path.basename(file)} shows different words from terms.continue.v1`);
    }
  });

  await frontendTest("the sign-up page carries no marketing wording", () => {
    /*
     * Marketing texts are offered in account settings and nowhere else. Not a
     * box, not a sentence, not a "we may send you offers" - none of it belongs
     * on the screen where an account is created.
     */
    for (const file of [P.signup, P.authSteps]) {
      const text = renderedText(readMarkup(file));
      assert.ok(
        !/\boffers?\b|promotion|marketing|special deals|discounts?/i.test(text),
        `${path.basename(file)} mentions marketing; it is offered only in account settings and on the mobile-number screen`
      );
    }
    // The mobile-number screen offers it in its one box and nowhere else on the screen.
    const contactText = renderedText(readMarkup(P.contact).replace(/const OFFERS_LABEL = "[^"]+";/, ""));
    assert.ok(!/promotion|special deals|discounts?/i.test(contactText), "no promotional wording outside the box");
  });

  await frontendTest("the method screen states the Terms the same way, without the text clause", () => {
    const text = renderedText(readMarkup(P.authSteps));
    assert.ok(
      text.includes("By continuing, you agree to the Terms and Privacy Policy."),
      "Google, Apple and email accept the same Terms in the same words"
    );
    assert.ok(!/verification text/.test(text), "only the phone screens send a text, so only they mention one");
  });

  await frontendTest("continuing sends the number and nothing else", () => {
    /*
     * POST /api/auth/otp/phone/start takes {phone}. A consent field sent with
     * it would be consent inferred from requesting a code, which is exactly
     * what the registered flow says never happens.
     */
    for (const file of [P.signup, P.contact]) {
      const src = readMarkup(file);
      const calls = src.match(/startPhoneOtp\(\{[^}]*\}\)/g) || [];
      assert.ok(calls.length >= 2, `${path.basename(file)}: expected the send and the resend`);
      for (const call of calls) {
        assert.ok(/^startPhoneOtp\(\{ phone: [^,}]+ \}\)$/.test(call), `${path.basename(file)} sends more than the number: ${call}`);
      }
    }
    const lib = readMarkup(P.auth2);
    assert.ok(
      /export async function startPhoneOtp\(input: \{ phone: string \}\)/.test(lib),
      "the client must not even accept a consent field for the code"
    );
  });

  /* ==================================================================== */
  section("The booking step offers service texts: one box, unticked, service only");

  await frontendTest("the booking opt-in starts unticked and is never restored from anywhere", () => {
    const src = readMarkup(P.optIn);
    assert.ok(
      /const \[serviceTexts, setServiceTexts\] = useState\(false\)/.test(src),
      "the box must start unticked; a pre-ticked box is not affirmative consent"
    );
    assert.ok(!/defaultChecked|checked=\{true\}|setServiceTexts\(true\)/.test(src), "nothing may tick it but the customer");
    assert.ok(!/localStorage|sessionStorage/.test(src), "a remembered tick is a pre-ticked box");
    assert.strictEqual((src.match(/type="checkbox"/g) || []).length, 1, "ONE box");
  });

  await frontendTest("its wording is the registered wording, word for word", () => {
    /*
     * v2 (2026-11-03): the brand in the label and "Optional." leading the line.
     * The booking step records CURRENT.booking.service, so that is the version
     * the screen must match - not merely some version that once existed.
     */
    const src = readSource(P.optIn);
    const { CURRENT } = require(path.join(__dirname, "..", "utils", "consent", "consentText.js"));
    assert.strictEqual(CURRENT.booking.service, "sms_service.booking.v2", "the booking step records v2");
    const registered = VERSIONS()[CURRENT.booking.service].text;
    assert.ok(registered.includes('"Text me about my ProFixter visits" (optional, unticked)'), "the registered label");
    assert.ok(/const LABEL = "Text me about my ProFixter visits";/.test(src), "the label on screen");
    const details = (src.match(/const DETAILS =\s*"([^"]+)"/) || [])[1];
    assert.ok(details, "the line under the label must be a single constant");
    assert.ok(
      registered.includes(`"${details}"`),
      "the line under the label must be the registered sentence, word for word"
    );
    for (const phrase of ["Optional.", "Message frequency varies", "Message and data rates may apply", "Reply STOP to opt out or HELP for help."]) {
      assert.ok(details.includes(phrase), `the booking box must state: ${phrase}`);
    }
    /* v1 stays, unchanged, for the rows recorded under it. */
    assert.ok(VERSIONS()["sms_service.booking.v1"].text.includes('"Text me about my visits"'), "v1 must not be edited or removed");
  });

  await frontendTest("it is service-only and can never switch on marketing", () => {
    const src = readMarkup(P.optIn);
    const puts = src.match(/API\.put\([^)]*\)/g) || [];
    assert.strictEqual(puts.length, 1, "one request, and only one");
    assert.ok(
      /API\.put\("\/api\/users\/me\/sms-preferences", \{ transactionalEnabled: true, source: "booking_step" \}\)/.test(puts[0]),
      `the request must be exactly service texts from the booking step: ${puts[0]}`
    );
    assert.ok(!/marketingEnabled|\boffers?\b|promotion/i.test(src), "the booking box must never mention or send marketing");
  });

  await frontendTest("reading what the box means does not tick it", () => {
    const src = readMarkup(P.optIn);
    const labelClose = src.indexOf("</label>");
    const anchor = src.indexOf('href="/communication-consent#service-texts"');
    assert.ok(labelClose > -1 && anchor > -1, "the box needs both a label and a Details link to #service-texts");
    assert.ok(anchor > labelClose, "the SMS Terms link must sit OUTSIDE the label, or following it ticks the box");
  });

  await frontendTest("the box links the SMS Terms, Privacy Policy and Terms of Service, each in a new tab", () => {
    /*
     * The disclosures a carrier reviewer looks for at every opt-in, at the box
     * itself (2026-11-03). All three sit after the label, so none of them can
     * tick it, and each opens in a new tab so the booking is not lost.
     */
    const src = readMarkup(P.optIn);
    const labelClose = src.indexOf("</label>");
    const start = src.indexOf("<p", labelClose);
    const para = src.slice(start, src.indexOf("</p>", start) + 4);
    let last = para.indexOf("{DETAILS}");
    assert.ok(last > -1, "the disclosure line must open the paragraph under the label");
    for (const [href, text] of [["/communication-consent#service-texts", "SMS Terms"], ["/privacy", "Privacy"], ["/terms", "Terms"]]) {
      const link = new RegExp(`<a href="${href}" target="_blank" rel="noopener noreferrer"[^>]*>\\s*${text}\\s*</a>`);
      assert.ok(link.test(para), `the booking box must link ${text} (${href}) in a new tab, in the line under the label`);
      const at = para.indexOf(`href="${href}"`);
      assert.ok(at > last, `${text} must follow the disclosure, in order: SMS Terms, Privacy, Terms`);
      last = at;
    }
  });

  await frontendTest("every booking flow shows it above the button and saves it only after the booking succeeds", () => {
    /*
     * Never a condition of booking: nothing reads the tick before the booking
     * is made, and the save runs only once the server has accepted it (or, for
     * paid visits, has opened checkout for it).
     */
    for (const [file, submitCalls, button] of [
      [P.freeVisit, ["await createBooking("], 'data-fv="book"'],
      [P.memberBooking, ["await createBooking("], "onClick={handleBookNow}"],
      [P.oneTime, ["await createOneTimeVisitCheckout("], "onClick={submit}"],
      [P.fullDay, ["await bookIncludedFullDay(", "await createFullDayCheckout("], "onClick={submit}"],
      /* Book a Handyman (CX4): member visit, one-time checkout, membership checkout. */
      [P.handyman, ["await createBooking(", "await createOneTimeVisitCheckout(", 'await API.post("/api/stripe/checkout/create-checkout-session"'], 'data-action="book-handyman"'],
    ]) {
      /*
       * Raw source, not readMarkup: FreeVisitBooker has accept="image/*", and
       * the comment stripper reads that as the start of a comment.
       */
      const src = readSource(file);
      const name = path.basename(path.dirname(file)) + "/" + path.basename(file);
      assert.ok(src.includes("useServiceTextsOptIn()"), `${name} must use the shared opt-in`);
      /* Each submit is followed, within its own success path, by the save... */
      for (const submitCall of submitCalls) {
        const call = src.indexOf(submitCall);
        assert.ok(call > -1, `${name}: ${submitCall} not found`);
        const apply = src.indexOf("await applyServiceTextsOptIn()", call);
        assert.ok(apply > call && apply - call < 900, `${name} must save the choice right after ${submitCall.trim()} succeeds`);
      }
      /* ...and no save happens anywhere before the first submit. */
      const first = Math.min(...submitCalls.map((c) => src.indexOf(c)));
      assert.strictEqual(
        src.slice(0, first).indexOf("applyServiceTextsOptIn()"),
        -1,
        `${name} applies the choice before the booking is made`
      );
      assert.strictEqual(
        (src.match(/await applyServiceTextsOptIn\(\)/g) || []).length,
        submitCalls.length,
        `${name}: one save per successful submit, no more`
      );
      const buttonAt = src.lastIndexOf(button);
      const render = src.lastIndexOf("{serviceTextsOptIn ?", buttonAt);
      assert.ok(render > -1 && buttonAt - render < 700, `${name} must render the box just above its submit button`);
      assert.ok(!/serviceTexts\s*&&|if \(!?serviceTexts/.test(src), `${name} must not read the tick as a condition`);
    }
  });

  await frontendTest("it is offered only to a signed-in customer with a phone who has not already said yes", () => {
    const src = readMarkup(P.optIn);
    assert.ok(
      /Boolean\(isAuthenticated && user\?\.phone && user\?\.smsServiceTexts !== true\)/.test(src),
      "shown only with a phone on the account and service texts not already on"
    );
  });

  /* ==================================================================== */
  section("The guest Free Visit request: no account, no checkbox, that one visit only");

  await frontendTest("the line on screen is the line the server stores, word for word", () => {
    /*
     * routes/freeVisitRequests.js refuses a request whose consentText is not a
     * line it knows, and stores the one that was shown. The form must send -
     * and show - the current one exactly.
     */
    const expected = serverGuestLine();
    assert.strictEqual(
      expected,
      "By requesting a visit, you agree that ProFixter may call or text you about this visit. Message frequency varies. Msg & data rates may apply. Reply STOP to opt out or HELP for help.",
      "the guest consent line itself changed; re-approve it (and the public pages) before updating this test"
    );
    const src = readSource(P.guestForm);
    const shown = (src.match(/const CONTACT_CONSENT_TEXT =\s*"([^"]+)";/) || [])[1];
    assert.strictEqual(shown, expected, "FreeVisitForm shows different words from the line the server stores");
  });

  await frontendTest("it names the brand, the frequency, the rates, STOP and HELP, and this visit only", () => {
    const line = serverGuestLine();
    for (const phrase of ["ProFixter", "call or text you about this visit", "Message frequency varies", "Msg & data rates may apply", "Reply STOP to opt out or HELP for help."]) {
      assert.ok(line.includes(phrase), `the guest line must state: ${phrase}`);
    }
    assert.ok(!/\boffers?\b|promotion|marketing|discount/i.test(line), "the guest line covers this visit, never marketing");
  });

  await frontendTest("it sits directly under the request button, with the SMS Terms and Privacy linked in a new tab", () => {
    const markup = readMarkup(P.guestForm);
    const button = markup.indexOf('data-action="review-free-visit"');
    const start = markup.indexOf("<p", button);
    assert.ok(button > -1 && start > button, "the request button and the line after it");
    const para = markup.slice(start, markup.indexOf("</p>", start) + 4);
    assert.ok(para.includes("data-contact-consent"), "the paragraph right after the button must be the consent line");
    assert.ok(para.includes("{CONTACT_CONSENT_TEXT}"), "and it must print the line the form sends");
    for (const [href, text] of [["/communication-consent#service-texts", "SMS Terms"], ["/privacy", "Privacy"]]) {
      assert.ok(
        new RegExp(`<a href="${href}" target="_blank" rel="noopener noreferrer">\\s*${text}\\s*</a>`).test(para),
        `the guest line must link ${text} (${href}) in a new tab`
      );
    }
    assert.ok(markup.slice(button, start).indexOf("</button>") > -1, "nothing but the button's close sits between them");
    assert.strictEqual(markup.slice(markup.indexOf("</button>", button), start).replace(/\s+/g, ""), "</button>", "the line is the very next element");
  });

  await frontendTest("the form has no checkbox and sends exactly the line it showed", () => {
    /*
     * The owner's design: no account and no box. The press is the act, so the
     * evidence is the line beside it - and that only holds if the form sends
     * the very constant it prints.
     */
    const markup = readMarkup(P.guestForm);
    assert.ok(!/type="checkbox"/.test(markup), "the guest request has no checkbox; a box would be a different, unregistered flow");
    assert.strictEqual((markup.match(/consentText: CONTACT_CONSENT_TEXT,/g) || []).length, 1, "the request must carry the line it showed");
    assert.ok(!/consentText: (?!CONTACT_CONSENT_TEXT,)/.test(markup), "and never any other wording");
  });

  /* ==================================================================== */
  section("Account settings keep both choices, separate and unticked");

  await frontendTest("two separate boxes with the registered wording, neither pre-ticked", () => {
    const src = readSource(P.smsPrefs);
    const all = VERSIONS();
    for (const [field, version] of [["transactionalEnabled", "sms_service.settings.v1"], ["marketingEnabled", "sms_marketing.settings.v1"]]) {
      const label = (all[version].text.match(/^"([^"]+)"/) || [])[1];
      assert.ok(label, `${version} must quote its label`);
      assert.ok(
        new RegExp(`field: "${field}",\\s*label: "${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(src),
        `${field} must keep its own box labelled "${label}"`
      );
    }
    assert.ok(/Text me occasional ProFixter offers\./.test(src), "the marketing choice is here and only here");
    assert.ok(!/defaultChecked|checked=\{true\}/.test(src), "neither box may be pre-ticked");
  });

  await frontendTest("under the boxes: the sending number and all three documents, in a new tab", () => {
    /* 2026-11-03: the documents behind both switches, at the switches. */
    const markup = readMarkup(P.smsPrefs);
    const start = markup.indexOf("<p", markup.indexOf("CHANNELS.map"));
    const para = markup.slice(start, markup.indexOf("</p>", start) + 4);
    assert.ok(para.includes("data-sms-documents"), "the line right after the two boxes must be the documents line");
    assert.ok(renderedText(para).startsWith("Texts come from ProFixter at (631) 888-6340."), `the sending number: ${renderedText(para)}`);
    for (const [href, text] of [["/communication-consent", "SMS Terms"], ["/privacy", "Privacy Policy"], ["/terms", "Terms of Service"]]) {
      assert.ok(
        new RegExp(`<a href="${href}" target="_blank" rel="noopener noreferrer"[^>]*>\\s*${text}\\s*</a>`).test(para),
        `account settings must link ${text} (${href}) in a new tab`
      );
    }
  });

  await frontendTest("the sending number and the support number are distinguished", () => {
    /*
     * The two numbers, the frequency and rates disclosures, and STOP/HELP live
     * on /communication-consent, which every link from a point of consent
     * reaches.
     */
    const src = readSource(P.consent);
    assert.ok(src.includes("888-6340"), "the sending number must be named");
    assert.ok(src.includes("599-1363"), "the customer-service number must be named");
    assert.ok(
      /sent from|Texts are sent from/i.test(src),
      "the page must say which number the texts come FROM"
    );
  });

  await frontendTest("the consent links land on the disclosures", () => {
    const consent = readSource(P.consent);
    for (const [what, pattern] of [
      ["message frequency", /frequency var/i],
      ["message and data rates", /message and data rates may apply/i],
      ["STOP", /\bSTOP\b/],
      ["HELP", /\bHELP\b/],
    ]) {
      assert.ok(pattern.test(consent), `${what} must appear on the page the links point to`);
    }
    assert.ok(readSource(P.optIn).includes("/communication-consent#service-texts"), "the booking box deep-links to service texts");
    for (const anchor of ["service-texts", "marketing"]) {
      assert.ok(consent.includes(`id="${anchor}"`), `#${anchor} must exist on the consent page`);
    }
  });

  /* ==================================================================== */
  section("The legal pages describe the system we actually built");

  await frontendTest("no page claims texting in is a way to opt in", () => {
    /*
     * routes/smsWebhook.applyOptIn grants no consent, and smsEligibility
     * refuses any number with no account behind it. A page saying otherwise
     * both misleads a customer and declares an undeclared second opt-in method,
     * which Twilio names as a cause of error 30896.
     */
    for (const file of [P.consent, P.privacy, P.terms, P.evidence]) {
      const src = readSource(file);
      assert.ok(
        !/opt in by initiating a conversation/i.test(src),
        `${path.basename(path.dirname(file))} still claims a text-in opt-in`
      );
    }
  });

  await frontendTest("the consent page names all six places consent is collected, and only those", () => {
    /*
     * It used to say "the booking step and your account settings are the only
     * places" and "we do not accept verbal or paper opt-ins". From 2026-11-03
     * both were false: the guest Free Visit line and a yes staff record on a
     * call are consent too. The page must name every place, exclude the rest,
     * and never bring the false claims back.
     */
    const src = readText(P.consent);
    const shown = renderedText(readMarkup(P.consent));
    assert.ok(/We collect SMS consent in these six places and nowhere else/i.test(src), "the page must name the places and exclude everything else");
    for (const [what, pattern] of [
      ["the booking step box", /The booking step \(signed in\): one optional, unchecked box, "Text me about my ProFixter visits"/],
      ["the guest Free Visit request", /The Free Visit request form \(no account\): no checkbox/],
      ["account settings", /Account settings: two separate, unchecked boxes/],
      ["the mobile-number screen", /The mobile-number screen \(signed in\), where you add or change the mobile number on your account: one optional, unchecked box, "Text me ProFixter offers, too\.", for marketing texts, recorded only after you enter the code that verifies the number\./],
      ["a call with staff", /A phone call with our staff, for texts about your visits only: staff must ask and record Yes or No; neither answer is pre-selected\. It is never used for marketing texts\./],
      ["the confirmation page", /profixter\.com\/texts\/confirm, for marketing texts, used only once this method is registered with the carriers/],
    ]) {
      assert.ok(pattern.test(shown), `the consent page must describe ${what} exactly`);
    }
    assert.ok(shown.includes(`"${serverGuestLine()}"`), "the consent page must quote the guest line exactly");
    assert.ok(/The phone sign-up screen collects no SMS consent/i.test(src), "the page must say sign-up collects none");
    assert.ok(/Verifying a number is never consent by itself/i.test(src), "verifying a number is never consent");
    assert.ok(/Twilio Verify/.test(src), "the page must say how the one-time code is sent");
    assert.ok(
      /Marketing texts are offered to customers only in account settings and on the mobile-number screen until the\s+confirmation page is registered/i.test(src),
      "marketing must be described as offered in settings and on the mobile-number screen only, until the confirmation page is registered"
    );
    assert.ok(/We never send marketing texts on a yes given on a phone call/i.test(src), "a spoken yes never starts marketing");
    assert.ok(
      /Texting us does not by itself subscribe you/i.test(src),
      "the page must say texting in is not consent"
    );
    for (const stale of [/only places we collect SMS consent/i, /do not accept verbal/i, /no verbal opt-in/i, /verbal or paper opt-ins/i, /"Text me about my visits"/]) {
      assert.ok(!stale.test(shown), `the consent page still says something no longer true: ${stale}`);
    }
  });

  await frontendTest("the consent-record claim matches what is actually stored", () => {
    /*
     * The schema holds a status, a timestamp and a source. It does not hold a
     * consent language version, and the page used to say it did.
     */
    const src = readSource(P.consent);
    assert.ok(
      !/consent language version/i.test(src),
      "we do not store a consent language version; claiming it is a promise we cannot honour"
    );
    assert.ok(/consent status/i.test(src) && /date and time/i.test(src));
  });

  await frontendTest("no public page still says texts are required to have an account", () => {
    /*
     * The old flow required the service box to register. Any page still
     * saying so describes a flow that no longer exists - and contradicts the
     * registered campaign, which is the comparison a reviewer makes.
     */
    for (const file of [P.consent, P.privacy, P.terms, P.evidence]) {
      const text = readText(file);
      for (const pattern of [
        /Service (text messages|texts|SMS) (are|is) required/i,
        /requires agreeing to receive service texts/i,
        /required to create (a ProFixter |an )?account[^.]{0,40}service text/i,
        /Service texts are part of having an account/i,
        /checkbox at sign-up/i,
      ]) {
        assert.ok(!pattern.test(text), `${path.basename(path.dirname(file))} still describes the old flow: ${pattern}`);
      }
    }
  });

  await frontendTest("START semantics stay explicit on the consent page", () => {
    const src = readText(P.consent);
    assert.ok(/does not grant service SMS consent/i.test(src));
    assert.ok(/does not grant marketing SMS consent/i.test(src));
  });

  await frontendTest("/terms links to the SMS terms", () => {
    const src = readSource(P.terms);
    assert.ok(
      src.includes('href="/communication-consent"'),
      "the Terms must link the full SMS programme terms"
    );
  });

  await frontendTest("the approved non-sharing language is intact", () => {
    const src = readText(P.privacy);
    const required =
      "Mobile information and SMS consent will not be shared with third parties or affiliates for marketing or promotional purposes";
    assert.ok(src.includes(required), "the 30908 fix must not be weakened or reworded");
  });

  await frontendTest("the legal pages carry no marketing call to action", () => {
    for (const file of [P.privacy, P.terms, P.consent]) {
      const src = readSource(file);
      assert.ok(
        !/>\s*Create Account\s*</.test(src),
        `${path.basename(path.dirname(file))} still ends in a conversion CTA`
      );
    }
  });

  await frontendTest("no promotion may cover a compliance page", () => {
    const src = readSource(P.popup);
    for (const route of ["/privacy", "/terms", "/communication-consent", "/sms-consent-example"]) {
      assert.ok(
        new RegExp(`"${route}"`).test(src),
        `${route} must be excluded from the visitor promotion popup`
      );
    }
    assert.ok(
      /COMPLIANCE_PATHS\.some/.test(src),
      "the exclusion list has to actually be consulted"
    );
  });

  /* ==================================================================== */
  section("The brand and the company are publicly connected");

  await frontendTest("the footer names the legal entity on every page", () => {
    const src = readSource(P.footer);
    assert.ok(
      /Premium Island Homes Inc\., d\/b\/a ProFixter/.test(src),
      "the footer must connect the trading name to the registered company"
    );
    assert.ok(src.includes("HI-71484"), "the licence number stays in the footer");
  });

  await frontendTest("/about names the operating company", () => {
    const src = readSource(P.about);
    assert.ok(
      /Premium Island Homes Inc\./.test(src),
      "About Us is the first place anyone looks for the company behind a brand"
    );
  });

  await frontendTest("the evidence page is reachable from the footer", () => {
    const arch = readSource(P.architecture);
    assert.ok(
      arch.includes('href: "/sms-consent-example"'),
      "a page a reviewer has to be handed by email is not public evidence"
    );
    const footer = readSource(P.footer);
    assert.ok(
      footer.includes("SMS Consent"),
      "the compact footer must keep the SMS Consent entry alongside the other legal links"
    );
  });

  /* ==================================================================== */
  section("The evidence page is evidence, and never a second opt-in");

  await frontendTest("the evidence page exists", () => {
    assert.ok(fs.existsSync(P.evidence), "/sms-consent-example must exist");
  });

  await frontendTest("it contains no form and no consent control", () => {
    /*
     * THE INVARIANT THAT MATTERS MOST ON THIS PAGE.
     *
     * The moment it grows an input, it stops being a description of the opt-in
     * flow and becomes an opt-in flow of its own - an undeclared one, which is
     * exactly the finding it was built to answer.
     */
    const src = readSource(P.evidence);
    for (const forbidden of ["<form", "<input", "<textarea", "<select", 'type="checkbox"', "onSubmit"]) {
      assert.ok(
        !src.includes(forbidden),
        `the evidence page must never contain ${forbidden} - that would make it a second opt-in method`
      );
    }
  });

  await frontendTest("it states the company, the licence and both numbers", () => {
    const src = readText(P.evidence);
    assert.ok(/Premium Island Homes Inc\./.test(src));
    assert.ok(src.includes("HI-71484"));
    assert.ok(src.includes("631-888-6340"), "the sending number");
    assert.ok(src.includes("631-599-1363"), "the customer-service number");
    assert.ok(
      /two different numbers on purpose/i.test(src),
      "a reviewer must be told the numbers differ deliberately, not left to assume a typo"
    );
  });

  await frontendTest("it makes every required negative claim", () => {
    const src = readText(P.evidence);
    const claims = [
      /Requesting a verification code is not SMS consent/i,
      /Entering a phone number is not consent/i,
      /Accepting the Terms of Service is not SMS consent/i,
      /Texting ProFixter is not SMS consent/i,
      /Replying START or UNSTOP is not SMS consent/i,
      /There is no keyword opt-in, and no purchased, rented or shared list/i,
      /A yes given on a phone call covers only texts about that caller(?:'|&apos;)s visits, and is never used for marketing texts/i,
      /Marketing texts are never sent on what staff record/i,
    ];
    for (const claim of claims) {
      assert.ok(claim.test(src), `the evidence page is missing: ${claim}`);
    }
  });

  await frontendTest("it no longer makes the claims that stopped being true", () => {
    /*
     * "Exactly two places" and "no verbal opt-in" were true until the guest
     * Free Visit line and staff-recorded agreement existed (2026-11-03). A
     * reviewer who reads either and then meets the Free Visit form has found
     * an undeclared opt-in - the 30896 finding.
     */
    const shown = renderedText(readMarkup(P.evidence));
    for (const stale of [/exactly two places/i, /do not accept verbal/i, /do not accept paper/i, /no verbal opt-in/i, /no paper opt-in/i, /"Text me about my visits"/]) {
      assert.ok(!stale.test(shown), `the evidence page still says something no longer true: ${stale}`);
    }
  });

  await frontendTest("it lists every place consent is collected, each quoted exactly", () => {
    const src = readText(P.evidence);
    const markup = readMarkup(P.evidence);
    const shown = renderedText(markup);
    assert.ok(/SMS consent is\s+collected in these six places, and nowhere else/i.test(src), "the page must list the places and exclude the rest");
    for (const [what, pattern] of [
      ["the booking step", /The booking step \(signed-in customers\) - one optional, unchecked box, "Text me about my ProFixter visits"/],
      ["the guest request", /The Free Visit request form \(no account needed\) - .*There is no checkbox\..*pressing the button is the agreement\. It covers calls and texts about that one requested visit and nothing else, never marketing\./],
      ["account settings", /Account settings - two separate, unchecked boxes, one for service texts and one for marketing texts\./],
      ["the mobile-number screen", /The mobile-number screen \(signed-in customers\) - shown when a customer adds a mobile number to their account .*one optional, unchecked box, "Text me ProFixter offers, too\.", for marketing texts only\. It is recorded only after the customer enters the code that verifies the number/],
      ["a call with staff", /A phone call with ProFixter staff - for texts about the caller's own visits only\. Staff must ask.*they must choose Yes or No, and neither is pre-selected\. The record names the staff member and the time\./],
      ["the confirmation page", /The confirmation page profixter\.com\/texts\/confirm - for marketing texts, and only once this method is registered with the carriers\./],
    ]) {
      assert.ok(pattern.test(shown), `the evidence page must describe ${what}`);
    }
    /* Each screen's own words, as quoted wording blocks. */
    for (const quote of [
      serverGuestLine(),
      "Texts come from ProFixter at (631) 888-6340.",
      "Did they agree to texts about their visits?",
      "Yes, text me occasional ProFixter offers",
    ]) {
      assert.ok(markup.includes(`quote="${quote}"`), `the evidence page must quote the screen exactly: ${quote}`);
    }
    /* What staff record is quoted from the records themselves. */
    const adminPhone = VERSIONS()["sms_service.admin_phone.v1"].text;
    assert.ok(shown.includes(`"${adminPhone}"`), "the staff-recorded wording must be quoted from sms_service.admin_phone.v1");
    const visitRecord = readSource(path.join(__dirname, "..", "utils", "admin", "adminVisits.js"));
    assert.ok(visitRecord.includes("text: `Agreed by phone to be contacted by call or text about this visit; recorded in Admin by ${"), "the guest visit record the page quotes");
    assert.ok(shown.includes('"Agreed by phone to be contacted by call or text about this visit; recorded in Admin by" followed by the staff member\'s name'));
  });

  await frontendTest("it describes the registered flow: nothing at sign-up, both choices optional", () => {
    /*
     * Rewritten for Registration 2.0. A reviewer compares this page against
     * the live screens and the campaign; it must describe the flow that exists
     * - no SMS boxes at sign-up, the booking box, the settings boxes - and
     * quote each screen's words exactly.
     */
    const src = readText(P.evidence);
    const shown = renderedText(readMarkup(P.evidence));
    assert.ok(/The phone sign-up screen collects no SMS consent/i.test(src), "sign-up must be described as collecting none");
    assert.ok(/Verifying\s+a number is never consent/i.test(src), "verifying a number is never consent");
    assert.ok(/no text-message checkboxes/i.test(src), "the sign-up screen has no SMS checkboxes");
    assert.ok(/Twilio Verify/.test(src), "the one-time code is sent through Twilio Verify");
    assert.ok(/Service SMS is optional/i.test(src), "service texts must be described as optional");
    assert.ok(/Marketing SMS is separately optional/i.test(src));
    assert.ok(/unchecked by default/i.test(src), "no box may be pre-ticked");
    assert.ok(/never pre-ticked/i.test(src), "the customer performs the tick");
    assert.ok(!/Service SMS is required/i.test(src), "the old required-service claim must be gone");
    for (const quote of [
      registeredQuote("terms.continue.v1"),
      registeredQuote("sms_service.booking.v2"),
      registeredQuote("sms_service.settings.v1"),
      registeredQuote("sms_marketing.settings.v1"),
      registeredQuote("sms_marketing.phone_verify.v1"),
      registeredQuote("sms_service.phone_change.v1"),
    ]) {
      assert.ok(
        shown.includes(quote) || readSource(P.evidence).includes(`quote="${quote}"`),
        `the evidence page must quote the screen exactly: ${quote}`
      );
    }
    assert.ok(
      /switch on marketing texts\s+themselves only here or with the optional box on the mobile-number screen/i.test(src),
      "marketing must be described as switched on by customers themselves, in account settings or on the mobile-number screen only"
    );
    assert.ok(/Message frequency varies/.test(src) && /Message and data rates may apply/.test(src));
  });

  await frontendTest("it links all four public documents", () => {
    const src = readSource(P.evidence);
    for (const href of ["/signup", "/privacy", "/terms", "/communication-consent"]) {
      assert.ok(src.includes(`href="${href}"`), `${href} must be linked directly`);
    }
  });

  await frontendTest("it references the five current screenshots, and no old one", () => {
    /*
     * The old five showed the three-box sign-up form, which no longer exists.
     * The v2 three (2026-10-28) showed the old booking box and no Free Visit
     * request. Their files stay in public/ (history), but the page must not
     * show them: a screenshot of a screen that is gone is evidence of the
     * wrong flow.
     */
    const src = readSource(P.evidence);
    const shots = [
      "/compliance/a2p-v3-signup.png",
      "/compliance/a2p-v3-booking.png",
      "/compliance/a2p-v3-free-visit.png",
      "/compliance/a2p-v3-settings.png",
      "/compliance/a2p-v3-phone.png",
    ];
    for (const shot of shots) {
      assert.ok(src.includes(shot), `missing screenshot reference ${shot}`);
      const file = path.join(FRONTEND, "public", shot);
      assert.ok(fs.existsSync(file), `${shot} is referenced but not committed`);
    }
    for (const old of ["a2p-signup-desktop", "a2p-signup-mobile", "a2p-signup-terms-separate", "a2p-registered-no-sms", "a2p-account-sms-switches", "a2p-v2-signup", "a2p-v2-booking", "a2p-v2-settings"]) {
      assert.ok(!src.includes(`/compliance/${old}.png`), `the evidence page still shows an old screen: ${old}`);
    }
  });

  await frontendTest("it describes STOP and START accurately", () => {
    const src = readText(P.evidence);
    assert.ok(/switches both stored preferences off/i.test(src), "STOP clears the stored preferences");
    assert.ok(
      /START or UNSTOP removes the block on the handset and nothing more/i.test(src),
      "START must not be described as resuming messages"
    );
  });

  /* ==================================================================== */
  console.log("");
  if (skipped.length) {
    console.log(`Skipped - no FrontEnd checkout beside this repo:`);
    for (const name of skipped) console.log(`  - ${name}`);
    console.log("");
  }
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} failed`);
    process.exit(1);
  }
  console.log(`${passed} passed, 0 failed${skipped.length ? `, ${skipped.length} skipped` : ""}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
