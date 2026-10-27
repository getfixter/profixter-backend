const EmailSuppression = require("../../models/EmailSuppression");

/**
 * Mirror Amazon SES's account suppression list into EmailSuppression.
 *
 * SES already refuses to deliver to an address on that list (a hard bounce
 * or a spam complaint), but the app could not see it: such an address
 * counted as reachable and a send to it looked accepted. With the list
 * mirrored, every marketing check (isUnsubscribed, the audit, Marcus's
 * counts, the campaign audience) excludes it like any other suppression.
 *
 * READ-ONLY toward AWS: ses:ListSuppressedDestinations only (IAM inline
 * policy ProfixterSesSuppressionRead on the EB instance role). Nothing is
 * ever removed from SES, and nothing is sent.
 *
 *   on the SES list, no row        -> a row: reason bounce/complaint, flagged
 *   on the SES list, existing row  -> flagged (its own reason and history kept)
 *   flagged, no longer on the list -> flag cleared; a row this sync created
 *                                     is lifted (resubscribedAt), any other
 *                                     row goes back to exactly what it was
 */
const SOURCE = "ses_account_suppression";
const REGION = process.env.AWS_SES_REGION || "us-east-1";

let clientOverride = null;
function setClientForTests(client) {
  clientOverride = client;
}

async function listSuppressed() {
  const { SESv2Client, ListSuppressedDestinationsCommand } = require("@aws-sdk/client-sesv2");
  const client = clientOverride || new SESv2Client({ region: REGION });
  const out = [];
  let NextToken;
  for (let page = 0; page < 200; page += 1) {
    const r = await client.send(new ListSuppressedDestinationsCommand({ PageSize: 1000, ...(NextToken ? { NextToken } : {}) }));
    for (const d of r.SuppressedDestinationSummaries || []) {
      out.push({ email: String(d.EmailAddress || "").trim().toLowerCase(), reason: String(d.Reason || "").toLowerCase() === "complaint" ? "complaint" : "bounce", at: d.LastUpdateTime ? new Date(d.LastUpdateTime) : new Date() });
    }
    NextToken = r.NextToken;
    if (!NextToken) break;
  }
  return out.filter((d) => d.email.includes("@"));
}

async function syncSesSuppressions({ now = new Date() } = {}) {
  const listed = await listSuppressed();
  const onList = new Set(listed.map((d) => d.email));
  let added = 0;
  let flagged = 0;
  let cleared = 0;
  for (const d of listed) {
    const row = await EmailSuppression.findOne({ email: d.email });
    if (!row) {
      await EmailSuppression.create({ email: d.email, reason: d.reason, source: SOURCE, detail: "Amazon SES account suppression list", suppressedAt: d.at, providerSuppressed: { reason: d.reason, at: d.at } });
      added += 1;
    } else if (!row.providerSuppressed?.at) {
      await EmailSuppression.updateOne({ _id: row._id }, { $set: { providerSuppressed: { reason: d.reason, at: d.at } } });
      flagged += 1;
    }
  }
  const stale = await EmailSuppression.find({ "providerSuppressed.at": { $ne: null } }).lean();
  for (const row of stale) {
    if (onList.has(row.email)) continue;
    const set = { providerSuppressed: { reason: "", at: null } };
    if (row.source === SOURCE) Object.assign(set, { resubscribedAt: now, resubscribeSource: "ses_delisted" });
    await EmailSuppression.updateOne({ _id: row._id }, { $set: set });
    cleared += 1;
  }
  return { listed: listed.length, added, flagged, cleared };
}

module.exports = { SOURCE, setClientForTests, syncSesSuppressions };
