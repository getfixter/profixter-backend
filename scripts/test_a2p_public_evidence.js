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
};

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
  section("The opt-in page carries the documents it has to carry");

  await frontendTest("every document the opt-in has to carry is linked from the form", () => {
    /*
     * These used to be three links in a disclosure paragraph under the boxes.
     * The owner removed that paragraph deliberately - the registration form
     * was reading as a compliance document - and the route to the SMS terms is
     * now the checkbox label itself, which is a link.
     *
     * So the requirement is unchanged and only the carrier moved: all three
     * documents must still be reachable without leaving the page guessing.
     */
    const src = readSource(P.signup);
    for (const href of ["/terms", "/privacy"]) {
      assert.ok(src.includes(`href="${href}"`), `${href} must be linked from the sign-up form`);
    }
    assert.ok(
      (src.match(/href="\/communication-consent/g) || []).length >= 2,
      "each consent label must be a link to the SMS terms, which is how they are now reached"
    );
  });

  await frontendTest("the phone field and both checkboxes share one form and one fieldset", () => {
    /*
     * TWILIO'S REMAINING ERROR, PINNED.
     *
     * "Your opt-in form doesn't have a phone number field connected to SMS
     * consent." It was right twice over: the phone input lived inside
     * {step === 3} so it did not exist at first paint, and the consent panel
     * sat after </form> so checkbox.form was null and the two controls never
     * shared a form at any step.
     *
     * Both halves are structural, so both are asserted structurally: the
     * fieldset opens before the phone input, both checkboxes are inside it,
     * and the whole thing closes before </form>.
     */
    const src = readMarkup(P.signup);

    const formOpen = src.indexOf("<form");
    const formClose = src.indexOf("</form>");
    const fieldsetOpen = src.indexOf("<fieldset");
    const fieldsetClose = src.indexOf("</fieldset>");
    const phone = src.indexOf('id="phone"');
    const service = src.indexOf('id="sms-service-consent"');
    const marketing = src.indexOf('id="sms-marketing-consent"');

    assert.ok(fieldsetOpen > -1, "the grouping fieldset must exist");
    assert.ok(formOpen < fieldsetOpen && fieldsetClose < formClose, "the fieldset must be inside the form");
    for (const [name, at] of [["phone", phone], ["service checkbox", service], ["marketing checkbox", marketing]]) {
      assert.ok(at > fieldsetOpen && at < fieldsetClose, `${name} must be inside the fieldset`);
    }
    assert.ok(/<legend/.test(src), "the fieldset needs a legend naming the group");
  });

  await frontendTest("the phone field is on the same step as the consent that refers to it", () => {
    /*
     * Twilio's campaign check rejected an earlier version of this page for
     * having "no phone number field connected to SMS consent", and the fix was
     * to put the number and the boxes in one fieldset inside one form.
     *
     * The owner has since moved consent to the final step, which gives up the
     * part of that fix that made the boxes visible at first paint. What must
     * NOT also be given up is the connection itself: wherever the boxes are,
     * the number is on that same screen, or a reviewer reaching the consent
     * step sees two checkboxes with nothing to attach them to.
     */
    const src = readMarkup(P.signup);
    const phone = src.indexOf('id="phone"');
    assert.ok(phone > -1, "the phone input must exist");
    const phoneStep = stepOf(src, phone);
    for (const id of ["sms-service-consent", "sms-marketing-consent"]) {
      assert.strictEqual(
        stepOf(src, src.indexOf(`id="${id}"`)),
        phoneStep,
        `${id} and the phone field must render on the same step`
      );
    }
  });

  await frontendTest("there is exactly one phone input on the page", () => {
    /*
     * One field, so the number consented for and the number on the account
     * are the same number by construction rather than by synchronisation.
     */
    const src = readSource(P.signup);
    assert.strictEqual(
      (src.match(/id="phone"/g) || []).length,
      1,
      "a second phone input would make the consented number ambiguous"
    );
    assert.strictEqual((src.match(/type="tel"/g) || []).length, 1);
  });

  await frontendTest("the form distinguishes the two categories, and marks the right one required", () => {
    /*
     * The labels have been through two rounds of simplification. They were
     * full sentences quoting the campaign - "Text me about my ProFixter visits
     * at the mobile number above" - then two short names with the words
     * Required and Optional printed beside them, and are now the two names
     * alone, each a link to the document that explains it.
     *
     * SO THE REQUIREMENT IS NO LONGER PRINTED ON THE FORM. It is carried in
     * the markup instead - the prop below, and the aria-required it drives -
     * and enforced when the customer presses Finish, by this form and again by
     * routes/auth.js. That is a deliberate product decision, and this case is
     * what stops it drifting into the opposite arrangement: the two categories
     * must stay distinguishable, and the REQUIRED one must stay the service
     * one.
     */
    const text = readText(P.signup);
    assert.ok(/Service text messages/i.test(text), "the service category must be named");
    assert.ok(/Offers &amp; promotions|Offers & promotions/i.test(text), "the marketing category must be named");
    const src = readSource(P.signup);
    assert.ok(
      /requirement="Required"/.test(src) && /requirement="Optional"/.test(src),
      "one box must be marked Required and the other Optional in the markup"
    );
    assert.ok(
      /aria-required=\{requirement === "Required"\}/.test(src),
      "with the word gone from the page, the control must still say so to assistive technology"
    );
    /*
     * Scoped to the <input> itself, with comments stripped first.
     *
     * Two earlier attempts at this case failed on prose rather than on code:
     * one searched the span between the two checkboxes and matched the inline
     * error message, and one matched the comment beside the prop explaining
     * why the word is required-ness rather than a required attribute. Both
     * were the test reading English and reporting it as markup.
     */
    const markup = readMarkup(P.signup);
    const rowStart = markup.indexOf("function ConsentRow(");
    const rowInput = markup.slice(rowStart, markup.indexOf("</label>", rowStart));
    assert.ok(
      !/\srequired(\s|=|\/|>)/.test(rowInput),
      "the HTML required attribute would hand the failure to the browser and bypass the inline message"
    );
    assert.ok(
      /label="Service text messages"[\s\S]{0,400}?requirement="Required"/.test(src),
      "the REQUIRED one must be the service box, never the marketing box"
    );
    assert.ok(
      /label="Offers &(amp;)? promotions"[\s\S]{0,400}?requirement="Optional"/.test(src),
      "marketing must be the optional one - requiring it is error 30923"
    );
  });

  await frontendTest("reading what a consent means does not give that consent", () => {
    /*
     * The label is the link now, and that is a trap worth a test.
     *
     * Anything inside a <label> forwards its clicks to the control, so an
     * anchor nested in the label would tick the box on the way to the page
     * explaining what the box does - consent recorded by a customer who was
     * trying to find out what they were agreeing to. In ConsentRow the label
     * wraps the tick target alone and the anchor is its sibling.
     */
    const src = readSource(P.signup);
    const row = src.slice(src.indexOf("function ConsentRow("), src.indexOf("export default function SignUpPage"));
    assert.ok(row.length > 0, "ConsentRow must exist");
    const labelClose = row.indexOf("</label>");
    const anchor = row.indexOf("<a");
    assert.ok(labelClose > -1 && anchor > -1, "the row needs both a label and a link");
    assert.ok(
      anchor > labelClose,
      "the consent link must sit OUTSIDE the label, or following it silently ticks the box"
    );
    assert.ok(
      /target="_blank"/.test(row) && /rel="noopener noreferrer"/.test(row),
      "the link must open in a new tab so a part-filled registration survives being read"
    );
  });

  await frontendTest("the Terms checkbox stays outside the SMS fieldset", () => {
    const src = readMarkup(P.signup);
    const terms = src.indexOf('id="agree-terms"');
    const fieldsetOpen = src.indexOf("<fieldset");
    const fieldsetClose = src.indexOf("</fieldset>");
    assert.ok(terms > -1, "the required Terms box must exist");
    assert.ok(
      terms < fieldsetOpen || terms > fieldsetClose,
      "Terms acceptance must not be grouped with the SMS consents"
    );
  });

  await frontendTest("nobody is asked about texts while they are typing an address", () => {
    /*
     * WHAT THIS USED TO SAY, AND WHY IT CHANGED.
     *
     * It used to require both SMS boxes on the FINAL step, on the reasoning
     * that consent is the last thing before the account is created. The owner
     * has since moved them onto the step that asks how to reach the customer -
     * "How can we reach you?", email and phone together - because a question
     * about texting somebody belongs beside the number the texts would go to,
     * not two screens away from it.
     *
     * That is a change of placement, not of protection. Everything Twilio
     * actually rejected this campaign for is asserted elsewhere in this file
     * and is untouched: the boxes are real, they start unchecked, neither
     * carries the HTML `required` attribute, each links to its own explanation,
     * they share one fieldset with the phone number inside one form, and
     * absence is still never consent on the server.
     *
     * What survives here is the part that was always about the customer rather
     * than the reviewer: a stranger who has typed nothing yet is not met with a
     * compliance form. The first step asks for an address and asks for nothing
     * else.
     */
    const src = readMarkup(P.signup);
    const SMS_CONTROLS = ["sms-service-consent", "sms-marketing-consent"];

    for (const id of SMS_CONTROLS) {
      const at = src.indexOf(`id="${id}"`);
      assert.ok(at > -1, `${id} must exist`);
      const step = stepOf(src, at);
      assert.ok(step !== null, `${id} must render inside a step branch, not on every step`);
      assert.ok(step > 1, `${id} must not be on the first step - it was on step ${step}`);
    }

    /*
     * Terms stays last, with the button that creates the account. Agreeing to
     * the Terms of Service is the act of creating the account, so it belongs on
     * the screen where that happens.
     */
    const last = finalStep(src);
    const terms = src.indexOf('id="agree-terms"');
    assert.ok(terms > -1, "agree-terms must exist");
    assert.strictEqual(stepOf(src, terms), last, `agree-terms must be on the final step, step ${last}`);
  });

  await frontendTest("both SMS boxes still start unchecked and neither is required", () => {
    const src = readSource(P.signup);
    assert.ok(
      /useState\(false\)[\s\S]{0,80}smsTransactionalConsent|const \[smsTransactionalConsent, setSmsTransactionalConsent\] = useState\(false\)/.test(src),
      "service consent must default to false"
    );
    assert.ok(
      /const \[smsMarketingConsent, setSmsMarketingConsent\] = useState\(false\)/.test(src),
      "marketing consent must default to false"
    );
    assert.ok(
      !/required[\s\S]{0,40}sms-(service|marketing)-consent/.test(src),
      "neither SMS checkbox may be required"
    );
  });

  await frontendTest("the required Terms box carries no SMS consent", () => {
    const src = readSource(P.signup);
    const start = src.indexOf('id="agree-terms"');
    assert.ok(start > -1, "the required Terms checkbox must exist");
    /*
     * Exactly the one control, not "the next 900 characters" - which ran on
     * into the optional SMS panel below it and made this case assert the
     * opposite of what it means.
     */
    const end = src.indexOf("</ConsentCheckbox>", start);
    assert.ok(end > start, "the Terms checkbox must be a closed element");
    /*
     * Comments and class names are stripped before the words are counted.
     * Tailwind spells half its utilities "text-white", "text-[12px]" and so on,
     * so a naive search for "text" inside this element matches the stylesheet
     * rather than the sentence - and a test that fails on a colour change while
     * passing on a consent change is worse than no test.
     */
    const box = src
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/className="[^"]*"/g, " ");
    /*
     * Both documents named, checked separately.
     *
     * This was one contiguous match on "Terms of Service and Privacy Policy",
     * which only held while the sentence was a plain string. The two documents
     * are now linked inside the sentence, so between them the source carries a
     * </Link>, an {" "} and an <a href>. What matters is unchanged: this box
     * names the Terms and the Privacy Policy, and names nothing else.
     */
    assert.ok(/Terms of Service/.test(box), "the Terms box must name the Terms of Service");
    assert.ok(/Privacy Policy/.test(box), "the Terms box must name the Privacy Policy");
    assert.ok(
      !/\btext\b|\bsms\b|\bmessage\b/i.test(box),
      "bundling SMS consent into the required box is error 30923"
    );
  });

  await frontendTest("the sending number and the support number are distinguished", () => {
    /*
     * WHERE THIS MOVED, AND WHY IT IS WORTH KNOWING.
     *
     * These two numbers, the frequency and rates disclosures, and STOP/HELP
     * used to appear in a paragraph beneath the sign-up checkboxes. The owner
     * removed that paragraph: the registration form had become a compliance
     * document, and this was most of it.
     *
     * They now live on /communication-consent, which is what both checkbox
     * labels link to. That is a deliberate product decision and not an
     * erosion - but it does mean the disclosures are one tap from the point of
     * consent rather than on it, so this test follows them there and holds
     * them to the same standard.
     */
    const src = readSource(P.consent);
    assert.ok(src.includes("888-6340"), "the sending number must be named");
    assert.ok(src.includes("599-1363"), "the customer-service number must be named");
    assert.ok(
      /sent from|Texts are sent from/i.test(src),
      "the page must say which number the texts come FROM"
    );
  });

  await frontendTest("the consent labels link to the disclosures that left the form", () => {
    /*
     * The link is now the only route from the point of consent to the
     * frequency, rates, STOP and HELP language, so it has to actually arrive
     * somewhere that carries it.
     */
    const consent = readSource(P.consent);
    for (const [what, pattern] of [
      ["message frequency", /frequency var/i],
      ["message and data rates", /message and data rates may apply/i],
      ["STOP", /\bSTOP\b/],
      ["HELP", /\bHELP\b/],
    ]) {
      assert.ok(pattern.test(consent), `${what} must appear on the page the labels link to`);
    }
    const signup = readSource(P.signup);
    for (const anchor of ["#service-texts", "#marketing"]) {
      assert.ok(
        signup.includes(`/communication-consent${anchor}`),
        `a label must deep-link to ${anchor} rather than the top of a long document`
      );
      assert.ok(
        consent.includes(`id="${anchor.slice(1)}"`),
        `${anchor} must exist on the consent page, or the label lands nowhere`
      );
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

  await frontendTest("the consent page states the sign-up form is the only place", () => {
    const src = readText(P.consent);
    assert.ok(
      /only places we collect SMS consent/i.test(src),
      "the page must name the two places consent is collected and exclude everything else"
    );
    assert.ok(
      /Texting us does not by itself subscribe you/i.test(src),
      "the page must say texting in is not consent"
    );
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
      /Entering a phone number is not consent/i,
      /Accepting the Terms of Service is not SMS consent/i,
      /Texting ProFixter is not SMS consent/i,
      /Replying START or UNSTOP is not SMS consent/i,
      /no verbal opt-in, no paper opt-in, no keyword opt-in, and no purchased, rented or shared list/i,
    ];
    for (const claim of claims) {
      assert.ok(claim.test(src), `the evidence page is missing: ${claim}`);
    }
  });

  await frontendTest("it states which choice is required and which is not", () => {
    /*
     * Converted when service SMS became a condition of registration. The
     * evidence page must now describe that accurately - a reviewer comparing
     * it against the live form is the entire reason this page exists, and a
     * page claiming "optional" above a required checkbox would be worse than
     * no page at all.
     */
    const src = readText(P.evidence);
    assert.ok(
      /Service SMS is required to create a ProFixter account/i.test(src),
      "the page must say service texts are required"
    );
    assert.ok(/Marketing SMS is separately optional/i.test(src));
    assert.ok(/unchecked by default/i.test(src), "neither box may be pre-ticked");
    assert.ok(
      /never pre-ticked/i.test(src),
      "required must still mean the customer performs the tick"
    );
  });

  await frontendTest("it links all four public documents", () => {
    const src = readSource(P.evidence);
    for (const href of ["/signup", "/privacy", "/terms", "/communication-consent"]) {
      assert.ok(src.includes(`href="${href}"`), `${href} must be linked directly`);
    }
  });

  await frontendTest("it references the five evidence screenshots", () => {
    const src = readSource(P.evidence);
    const shots = [
      "/compliance/a2p-signup-desktop.png",
      "/compliance/a2p-signup-mobile.png",
      "/compliance/a2p-signup-terms-separate.png",
      "/compliance/a2p-registered-no-sms.png",
      "/compliance/a2p-account-sms-switches.png",
    ];
    for (const shot of shots) {
      assert.ok(src.includes(shot), `missing screenshot reference ${shot}`);
      const file = path.join(FRONTEND, "public", shot);
      assert.ok(fs.existsSync(file), `${shot} is referenced but not committed`);
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
