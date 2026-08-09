/**
 * Minimal S3 stub for LOCAL testing only.
 *
 * Accepts any PUT/POST/DELETE and returns 200 so the booking photo-upload path
 * can be exercised end-to-end without real AWS credentials. Stores nothing.
 *
 * Point the backend at it with:
 *   AWS_ENDPOINT_URL=http://127.0.0.1:9000
 *   AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
 *
 *   node scripts/local_s3_stub.js
 */

const http = require("http");

const PORT = Number(process.env.S3_STUB_PORT || 9000);
let objectCount = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const size = Buffer.concat(chunks).length;
    if (req.method === "PUT" || req.method === "POST") {
      objectCount += 1;
      console.log(`[s3-stub] ${req.method} ${req.url} (${size} bytes) -> 200`);
      res.writeHead(200, { ETag: '"stub-etag"', "Content-Type": "application/xml" });
      res.end("");
      return;
    }
    if (req.method === "DELETE") {
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end('<?xml version="1.0" encoding="UTF-8"?><DeleteResult></DeleteResult>');
      return;
    }
    res.writeHead(200, { "Content-Type": "application/xml" });
    res.end("");
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[s3-stub] listening on http://127.0.0.1:${PORT} (local testing only)`);
});

process.on("SIGTERM", () => {
  console.log(`[s3-stub] received ${objectCount} objects`);
  server.close(() => process.exit(0));
});
