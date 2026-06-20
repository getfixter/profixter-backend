const assert = require("node:assert/strict");
const {
  getLeadRecipients,
  renderAdminLeadEmail,
  resolveLeadReplyTo,
  validEmail,
} = require("../utils/adminLeadNotification");
const { transporter } = require("../utils/emailService");

const rendered = renderAdminLeadEmail({
  leadId: "507f1f77bcf86cd799439011",
  leadType: "Bathroom Remodeling",
  service: "bathroom",
  name: "Taylor Homeowner",
  phone: "631-555-1212",
  email: "taylor@example.com",
  address: "100 Main Street, Babylon, NY 11702",
  message: "We would like to replace the shower and vanity.",
  contactPref: "email",
  timeline: "1-3 months",
  budgetRange: "$30,000-$60,000",
  submittedAt: "2026-06-20T16:00:00.000Z",
  sourcePage: "/estimate?type=bathroom",
});

assert.equal(
  rendered.subject,
  "New Profixter Lead: Bathroom Remodeling - Taylor Homeowner"
);
assert.ok(rendered.text.includes("Lead type: Bathroom Remodeling"));
assert.ok(rendered.text.includes("Mongo lead ID: 507f1f77bcf86cd799439011"));
assert.ok(rendered.text.includes("Source page: /estimate?type=bathroom"));
assert.ok(rendered.text.includes("Budget: $30,000-$60,000"));
assert.ok(rendered.html.includes("<table"));
assert.ok(!rendered.html.includes("<img"));
assert.ok(!rendered.html.includes("<button"));
assert.ok(!/[🔥🚨🎉]/u.test(rendered.subject));

assert.deepEqual(
  getLeadRecipients({
    MAIL_ADMIN: "Admin@Profixter.com",
    LEADS_EMAIL: "leads@profixter.com, admin@profixter.com",
  }),
  ["admin@profixter.com", "leads@profixter.com"]
);
assert.deepEqual(
  getLeadRecipients({
    MAIL_ADMIN: "admin@profixter.com",
    LEADS_EMAIL: "ADMIN@PROFIXTER.COM",
  }),
  ["admin@profixter.com"]
);
assert.deepEqual(getLeadRecipients({}), ["getfixter@gmail.com"]);

async function run() {
  assert.equal(validEmail("customer@example.com"), true);
  assert.equal(validEmail("not-an-email"), false);
  assert.equal(
    resolveLeadReplyTo("Customer@Example.com", "support@profixter.com"),
    "customer@example.com"
  );
  assert.equal(
    resolveLeadReplyTo("", "support@profixter.com"),
    "support@profixter.com"
  );

  const originalSendMail = transporter.sendMail;
  let capturedMail;
  transporter.sendMail = async (mail) => {
    capturedMail = mail;
    return { messageId: "test-admin-lead" };
  };

  try {
    const {
      sendAdminLeadNotification,
    } = require("../utils/adminLeadNotification");
    await sendAdminLeadNotification(
      {
        leadType: "Roofing",
        service: "Roofing",
        name: "Taylor Homeowner",
        email: "Customer@Example.com",
        phone: "631-555-1212",
      },
      {
        env: {
          MAIL_ADMIN: "admin@profixter.com",
          LEADS_EMAIL: "leads@profixter.com, ADMIN@PROFIXTER.COM",
        },
      }
    );
  } finally {
    transporter.sendMail = originalSendMail;
  }

  assert.equal(capturedMail.to, "admin@profixter.com, leads@profixter.com");
  assert.equal(capturedMail.replyTo, "customer@example.com");
  assert.equal(
    capturedMail.subject,
    "New Profixter Lead: Roofing - Taylor Homeowner"
  );
  assert.ok(capturedMail.text);
  assert.ok(capturedMail.html);

  console.log("Admin lead notification tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
