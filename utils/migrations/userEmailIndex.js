/**
 * One customer per email, kept true WHILE the rule changes.
 *
 * The old index made every account's email unique, including accounts with no
 * email - so a second phone-only customer could never be created. The new one
 * covers only accounts that have an email, which is the guarantee that
 * actually matters.
 *
 * Letting Mongoose's syncIndexes do this would drop the old index first and
 * build the new one second, leaving a window in which two customers could
 * register the same email. So the order is reversed and explicit:
 *
 *   1. build the new partial unique index BESIDE the old one (MongoDB 5.0+
 *      allows two indexes on the same keys when their filters differ);
 *   2. only once it exists, drop the old one.
 *
 * Every real email is covered by a unique index at every moment. Idempotent:
 * run on every boot, it does nothing once done.
 */

const OLD_NAME = "user_email_role_unique_idx";
const NEW_NAME = "user_email_role_unique_partial_idx";
const KEYS = { email: 1, role: 1 };
const FILTER = { email: { $type: "string" } };

async function migrateUserEmailIndex(collection, { log = () => {} } = {}) {
  let indexes = await collection.indexes();
  const steps = [];

  if (!indexes.some((index) => index.name === NEW_NAME)) {
    await collection.createIndex(KEYS, { unique: true, name: NEW_NAME, partialFilterExpression: FILTER });
    steps.push("created_partial");
    indexes = await collection.indexes();
  }

  const replacement = indexes.find((index) => index.name === NEW_NAME);
  const ready = replacement && replacement.unique && replacement.partialFilterExpression;
  const old = indexes.find((index) => index.name === OLD_NAME);
  if (old && ready) {
    await collection.dropIndex(OLD_NAME);
    steps.push("dropped_full");
  }

  if (steps.length) log({ event: "user_email_index_migrated", steps });
  return { steps };
}

module.exports = { NEW_NAME, OLD_NAME, migrateUserEmailIndex };
