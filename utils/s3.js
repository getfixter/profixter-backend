// backend/utils/s3.js
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const REGION  = process.env.S3_REGION || process.env.AWS_REGION || "us-east-1";
const BUCKET  = process.env.S3_BUCKET;
if (!BUCKET) throw new Error("S3_BUCKET env var is required");

const s3 = new S3Client({
  region: REGION,
  // No credentials here — EB instance profile supplies them
});

async function putPublicObject({ Bucket = BUCKET, Key, Body, ContentType, CacheControl }) {
  if (!Key) throw new Error("putPublicObject requires Key");
  if (!Body) throw new Error("putPublicObject requires Body");

  // 🚫 Do NOT set ACL when bucket has ownership-enforced (ACLs disabled)
  const cmd = new PutObjectCommand({
    Bucket,
    Key,
    Body,
    ContentType: ContentType || "application/octet-stream",
    CacheControl: CacheControl || "public, max-age=31536000, immutable",
  });

  await s3.send(cmd);

  // Public URL (works because your bucket policy allows s3:GetObject on this prefix)
  return `https://${Bucket}.s3.amazonaws.com/${Key}`;
}

module.exports = { putPublicObject };
