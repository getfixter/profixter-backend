# Infrastructure permissions (applied by the owner)

## profixter-prod-parameter-read.json

Inline policy `ProfixterProdParameterRead` on the EB instance role
`Profixter-EC2-S3Access`. It lets the backend read SecureString parameters
under `/profixter/prod/` (see `utils/secrets.js`) and decrypt them only
through SSM. Nothing else in Parameter Store is readable, and nothing is
writable.

    aws iam put-role-policy --role-name Profixter-EC2-S3Access \
      --policy-name ProfixterProdParameterRead \
      --policy-document file://infra/iam/profixter-prod-parameter-read.json

Secrets the backend reads from there (exact names, SecureString):
`ANTHROPIC_API_KEY`, `META_ADS_ACCESS_TOKEN` (ads_read only - never
ads_management), optionally `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD`.
