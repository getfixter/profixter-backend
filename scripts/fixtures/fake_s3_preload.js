/*
 * Test-only: loaded with `node --require` so a child process (an ops script
 * under test) stores nothing in real S3. Every put returns a fake public URL.
 */
process.env.S3_BUCKET = process.env.S3_BUCKET || "test-bucket";
const path = require("path");
const resolved = require.resolve(path.join(__dirname, "..", "..", "utils", "s3"));
require.cache[resolved] = {
  id: resolved,
  filename: resolved,
  loaded: true,
  exports: {
    putPublicObject: async ({ Key }) => `https://test-bucket.s3.amazonaws.com/${Key}`,
    deletePublicObjects: async () => ({ deleted: 0 }),
  },
};
