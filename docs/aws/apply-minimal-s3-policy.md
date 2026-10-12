# Narrowing the production server's S3 access (optional hardening, owner approval required)

Today the role `Profixter-EC2-S3Access` has **AmazonS3FullAccess** (every
bucket, every action). The backend only reads, writes and deletes objects in
`profixter-uploads-prod` (verified: all S3 calls go through `utils/s3.js` with
`S3_BUCKET`). This is independent of the Studio launch - do it before or after.

1. IAM -> Roles -> `Profixter-EC2-S3Access` -> Add permissions -> Create inline
   policy -> JSON -> paste `profixter-ec2-s3-minimal-policy.json` -> name
   `ProfixterUploadsBucketOnly`. (Adding it changes nothing yet.)
2. Detach `AmazonS3FullAccess` from the role.
3. Within a few minutes, check: book a visit with a photo (upload), open an
   existing contract PDF in Admin (private read), upload a Recent Work photo,
   and in the Shower Studio (after launch) upload a design photo.
4. **Rollback**: re-attach `AmazonS3FullAccess` (one click); nothing else changes.
   Keep `AWSElasticBeanstalkWebTier` and the SSM inline policy as they are.
