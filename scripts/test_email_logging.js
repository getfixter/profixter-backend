const assert = require("node:assert/strict");

const EmailLog = require("../models/EmailLog");
const emailService = require("../utils/emailService");

const tick = () => new Promise((resolve) => setImmediate(resolve));

async function run() {
  const originalCreate = EmailLog.create;
  const originalSendMail = emailService.transporter.sendMail;
  const logs = [];

  try {
    EmailLog.create = async (payload) => {
      logs.push(payload);
      return payload;
    };
    emailService.transporter.sendMail = async () => ({
      messageId: "provider-message-1",
      response: "250 OK",
      accepted: ["customer@example.com"],
      rejected: [],
      envelope: { to: ["customer@example.com"] },
    });

    const success = await emailService.sendTx(
      "booking_reminder_24h",
      "customer@example.com",
      { name: "Samantha", bookingNumber: "BK-1001" },
      {
        bccAdmin: false,
        logContext: {
          bookingNumber: "BK-1001",
          customerName: "Samantha",
          customerEmail: "customer@example.com",
          emailType: "reminder",
          source: "test",
        },
      }
    );

    assert.equal(success.messageId, "provider-message-1");
    await tick();
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, "sent");
    assert.equal(logs[0].templateKey, "booking_reminder_24h");
    assert.equal(logs[0].bookingNumber, "BK-1001");
    assert.equal(logs[0].providerMessageId, "provider-message-1");

    emailService.transporter.sendMail = async () => {
      const error = new Error("SMTP rejected");
      error.code = "EENVELOPE";
      error.responseCode = 550;
      throw error;
    };

    await assert.rejects(
      emailService.sendTx("booking_reminder_60m", "customer@example.com", {}, {
        bccAdmin: false,
        logContext: {
          bookingNumber: "BK-1002",
          customerEmail: "customer@example.com",
          emailType: "reminder",
          source: "test",
        },
      }),
      /SMTP rejected/
    );

    await tick();
    assert.equal(logs.length, 2);
    assert.equal(logs[1].status, "failed");
    assert.equal(logs[1].templateKey, "booking_reminder_60m");
    assert.equal(logs[1].errorCode, "EENVELOPE");
    assert.equal(String(logs[1].responseCode), "550");

    EmailLog.create = async () => {
      throw new Error("Mongo unavailable");
    };
    emailService.transporter.sendMail = async () => ({
      messageId: "provider-message-2",
      response: "250 OK",
    });

    const sentDespiteLogFailure = await emailService.sendTx(
      "welcome",
      "customer@example.com",
      { name: "Samantha" },
      { bccAdmin: false }
    );
    assert.equal(sentDespiteLogFailure.messageId, "provider-message-2");

    console.log("Email logging tests passed");
  } finally {
    EmailLog.create = originalCreate;
    emailService.transporter.sendMail = originalSendMail;
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
