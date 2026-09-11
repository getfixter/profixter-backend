const { escapeHtml, btn } = require("../emailService");

/**
 * The only markup an admin-edited email body may contain.
 *
 * WHY NOT JUST LET THEM WRITE HTML.
 *
 * Because "HTML from the database, rendered into an email" is a sentence with
 * no safe ending. An admin account is not a trusted compiler: a pasted
 * fragment, a copied snippet from a vendor, or one compromised admin session
 * would put arbitrary markup into mail we send under our own domain. And email
 * clients are far more forgiving than browsers about what they will execute or
 * fetch, so the blast radius is not limited to the admin screen.
 *
 * So nothing passes through. Every character an admin types is escaped, and the
 * only structure that survives is the small block syntax below, which this file
 * turns into our own styled markup. The output HTML is produced here, from
 * constants, and can therefore only ever be well-formed ProFixter markup.
 *
 * THE SYNTAX, WHICH IS DELIBERATELY BORING
 *
 *   # Heading                     one h2
 *   Blank-line-separated text     paragraphs
 *   - item                        bullet list
 *   **bold**                      strong
 *   [label](https://example.com)  link, https only
 *   {{token}}                     a value the system supplies
 *   {{actionButton}}              a system-built button, see below
 *
 * THE ACTION BUTTON IS THE POINT OF THE WHOLE DESIGN.
 *
 * Several of these emails exist to carry one secure link: a password code, a
 * gift claim URL, a signature request. An admin must be able to reword the
 * sentence around that button without being able to alter, remove or retarget
 * the URL inside it. So the URL is never text an admin can type - it arrives as
 * a token whose value is built by the system, and a link written by hand can
 * only point at https, never at a token-interpolated address.
 */

/** Links an admin writes by hand must be plain, absolute and https. */
const SAFE_URL = /^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;

const TOKEN = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Substitute tokens into already-escaped text.
 *
 * Values are escaped as they go in, EXCEPT the ones the system marked as
 * pre-rendered HTML (buttons and codes it built itself). That exception is
 * narrow and is keyed on the value's own shape rather than on its name, so an
 * admin cannot invent a token that claims to be trusted.
 */
function substitute(escapedText, values) {
  return escapedText.replace(TOKEN, (_m, name) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return "";
    const value = values[name];
    if (value && typeof value === "object" && value.__html) return String(value.__html);
    return escapeHtml(String(value ?? ""));
  });
}

/** Inline formatting, applied to text that is ALREADY html-escaped. */
function inline(escapedText, values) {
  let out = escapedText;

  /* Links: the label may contain tokens, the href may not. */
  out = out.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (match, label, href) => {
    if (!SAFE_URL.test(href)) return match; // leave it as literal text
    return `<a href="${href}" style="color:#0b5cab;text-decoration:none;font-weight:600;">${label}</a>`;
  });

  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return substitute(out, values);
}

/**
 * Turn an admin body into the HTML that goes inside the branded frame.
 *
 * Note the order: escape first, then recognise structure. Doing it the other
 * way round would mean deciding whether a `<` was markup before it had been
 * neutralised, which is where injection bugs live.
 */
function renderBody(markup, values = {}) {
  const source = String(markup || "").replace(/\r\n/g, "\n").trim();
  if (!source) return "";

  const blocks = source.split(/\n{2,}/);
  const html = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.trim();
    if (!block) continue;

    /* A block that is exactly one button token becomes a centred button. */
    const solo = block.match(/^\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}$/);
    if (solo) {
      const value = values[solo[1]];
      if (value && typeof value === "object" && value.__html) {
        html.push(`<div style="margin:18px 0;">${value.__html}</div>`);
        continue;
      }
    }

    if (block.startsWith("# ")) {
      const text = inline(escapeHtml(block.slice(2).trim()), values);
      html.push(`<h2 style="font-size:22px;font-weight:800;margin:0 0 10px">${text}</h2>`);
      continue;
    }

    const lines = block.split("\n");
    if (lines.every((l) => l.trim().startsWith("- "))) {
      const items = lines
        .map((l) => `<li style="margin:0 0 6px">${inline(escapeHtml(l.trim().slice(2)), values)}</li>`)
        .join("");
      html.push(`<ul style="margin:0 0 12px;padding-left:20px">${items}</ul>`);
      continue;
    }

    /* A single newline inside a paragraph is a line break, not a new block. */
    const text = inline(escapeHtml(block), values).replace(/\n/g, "<br />");
    html.push(`<p style="margin:0 0 12px">${text}</p>`);
  }

  return html.join("\n");
}

/** Subjects are plain text: tokens only, no markup, no HTML. */
function renderSubject(template, values = {}) {
  return String(template || "")
    .replace(TOKEN, (_m, name) => {
      const value = values[name];
      if (value && typeof value === "object" && value.__html) return "";
      return String(value ?? "");
    })
    .replace(/\s+/g, " ")
    .trim();
}

/** Mark a system-built fragment as safe to emit without escaping. */
function html(fragment) {
  return { __html: String(fragment || "") };
}

/** A standard ProFixter button, built here so no admin can retarget it. */
function actionButton(href, label, style = "primary") {
  if (!href || !SAFE_URL.test(String(href))) return html("");
  return html(btn(String(href), escapeHtml(String(label || "Open")), style));
}

/**
 * Validate an admin's email body and subject.
 *
 * Same philosophy as SMS: reject rather than repair. An unknown token would
 * render as nothing, which turns "Hi {{frstName}}," into "Hi ," on a real
 * customer's screen.
 */
function validate({ subject = "", body = "", allowed = [] }) {
  const errors = [];
  const allowedSet = new Set(allowed);

  if (!String(body).trim()) errors.push("The email body cannot be empty.");
  if (!String(subject).trim()) errors.push("The subject cannot be empty.");

  const combined = `${subject}\n${body}`;

  /* Leftover braces after removing valid tokens mean something did not parse. */
  if (/\{|\}/.test(combined.replace(TOKEN, ""))) {
    errors.push("Malformed variable. Every variable must look exactly like {{name}}.");
  }

  const used = new Set();
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(combined)) !== null) used.add(m[1]);
  for (const name of used) {
    if (!allowedSet.has(name)) {
      errors.push(`Unknown variable {{${name}}}. Available: ${allowed.join(", ")}`);
    }
  }

  /*
   * A raw URL an admin typed cannot become a link target unless it is https.
   * Flagged rather than silently left as text, so the reason is visible.
   */
  const badLinks = [...String(body).matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)].filter(
    ([, , href]) => !SAFE_URL.test(href)
  );
  for (const [, , href] of badLinks) {
    errors.push(
      `Link target "${href}" is not allowed. Write a full https:// address, or use a variable for system links.`
    );
  }

  if (/<[a-zA-Z/]/.test(body)) {
    errors.push(
      "HTML tags are not allowed in the body. Use # for a heading, ** ** for bold, - for a list, " +
        "and [label](https://…) for a link."
    );
  }

  return { valid: errors.length === 0, errors, usedTokens: [...used].sort() };
}

module.exports = {
  SAFE_URL,
  actionButton,
  html,
  renderBody,
  renderSubject,
  validate,
};
