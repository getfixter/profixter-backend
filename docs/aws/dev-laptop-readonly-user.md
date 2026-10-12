# Replacing the root access keys on the development laptop

The laptop's AWS CLI currently uses **root account access keys** (verified with
`aws sts get-caller-identity`; the keys themselves were never displayed or copied).
Root keys can do anything, including closing the account, and cannot be limited.

Recommended (owner does this in the AWS console; nothing was changed):

1. IAM -> Users -> Create user `taras-laptop` (no console access needed).
2. Attach the AWS managed policy **ReadOnlyAccess**. That covers what the
   laptop is used for: reading Elastic Beanstalk status and logs, S3 bucket
   settings, IAM review. It cannot read encrypted SSM secrets (no kms:Decrypt)
   and cannot change anything.
3. Create an access key for `taras-laptop`; on the laptop run `aws configure`
   and paste it in yourself (never in chat or a file in a repository).
4. Check: `aws sts get-caller-identity` shows `user/taras-laptop`, and
   `aws elasticbeanstalk describe-environments` still works.
5. Root user -> Security credentials -> **delete the root access keys**
   (root MFA is already on - keep it).
6. Deployments keep using the existing `github-eb-deploy` user from GitHub
   Actions; nothing about deployment changes.

If an occasional write is needed from the laptop later, add a narrow policy for
that one task to `taras-laptop`, or use the console.
