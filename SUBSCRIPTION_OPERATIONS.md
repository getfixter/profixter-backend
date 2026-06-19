# Subscription Cleanup and Reconciliation Operations

## Permanent automatic behavior

Stripe is the source of truth for Stripe-linked memberships.

The backend runs nightly reconciliation at `06:30 UTC` unless
`STRIPE_RECONCILIATION_ENABLED=false`. It:

- scans only local `active` or `trialing` subscriptions with a non-empty
  `stripeSubscriptionId`;
- retrieves the current subscription from Stripe;
- keeps and refreshes active/trialing subscriptions;
- marks missing or inactive Stripe subscriptions as canceled/inactive locally;
- synchronizes legacy `User.subscription` fields after changes;
- logs a summary under `subscription_reconciliation_completed`.

Booking creation also verifies Stripe before accepting a new booking. A stale
customer who attempts to book is denied and repaired immediately. The frequent
`GET /api/bookings/next` request uses the local safe predicate and does not call
Stripe.

## Required environment variables

These remain in Elastic Beanstalk environment properties:

- `MONGO_URI` or `MONGODB_URI`
- `STRIPE_SECRET_KEY`

Normal webhook processing also requires `STRIPE_WEBHOOK_SECRET`, but the manual
cleanup and reconciliation scripts do not.

Never copy these values into GitHub Actions, source control, command arguments,
or support tickets.

## NPM commands

From an environment that already has the production variables:

```bash
# Full Stripe-linked cleanup audit; no writes
npm run subscriptions:cleanup:dry

# Apply the full Stripe-linked cleanup
npm run subscriptions:cleanup

# Reconciliation audit; no writes
npm run subscriptions:reconcile:dry

# Synchronize subscriptions that still exist in Stripe
npm run subscriptions:reconcile
```

The cleanup commands skip legacy/manual subscriptions without a Stripe ID.
The underlying script supports `--include-legacy`, but that must not be used
without a separate review because it cancels DB-only subscriptions.

## Recommended manual production access: AWS Systems Manager

The current EB environment is `Handyman-v2-env`, and its instance profile is
`Profixter-EC2-S3Access`. At the time this runbook was written, the instance was
not registered with Systems Manager because that role only had S3 permissions.

### One-time AWS setup

1. Attach the AWS-managed policy `AmazonSSMManagedInstanceCore` to the role:

   ```bash
   aws iam attach-role-policy \
     --role-name Profixter-EC2-S3Access \
     --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
   ```

2. Wait several minutes and verify registration:

   ```bash
   aws ssm describe-instance-information \
     --filters Key=tag:elasticbeanstalk:environment-name,Values=Handyman-v2-env \
     --query 'InstanceInformationList[*].[InstanceId,PingStatus,AgentVersion]' \
     --output table
   ```

3. If no instance appears, replace/restart the EB instance so the current
   Amazon Linux 2023 image starts the SSM agent with the updated role. If the
   agent is not installed, use AWS's official SSM Agent installation procedure
   for Amazon Linux 2023 before continuing.

The IAM identity running manual commands also needs permission for
`ssm:SendCommand`, `ssm:GetCommandInvocation`, and read-only EC2/EB discovery.

### Run through the AWS console

1. Open **AWS Systems Manager → Run Command**.
2. Choose document **AWS-RunShellScript**.
3. Target the instance tagged:
   `elasticbeanstalk:environment-name = Handyman-v2-env`.
4. Use one command:

   ```bash
   sudo -E bash /var/app/current/scripts/run_eb_subscription_maintenance.sh cleanup-dry
   ```

5. Review command output before running:

   ```bash
   sudo -E bash /var/app/current/scripts/run_eb_subscription_maintenance.sh cleanup-write
   ```

The wrapper reads EB properties through `/opt/elasticbeanstalk/bin/get-config`
and does not print secret values.

### Run through AWS CLI

Discover the current instance because EB can replace instance IDs:

```bash
INSTANCE_ID="$(aws elasticbeanstalk describe-environment-resources \
  --environment-name Handyman-v2-env \
  --query 'EnvironmentResources.Instances[0].Id' \
  --output text)"
```

Send a dry run:

```bash
COMMAND_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "Profixter subscription cleanup dry run" \
  --parameters 'commands=["sudo -E bash /var/app/current/scripts/run_eb_subscription_maintenance.sh cleanup-dry"]' \
  --query 'Command.CommandId' \
  --output text)"

aws ssm get-command-invocation \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID"
```

After reviewing the dry-run output, replace `cleanup-dry` with `cleanup-write`.

## SSH fallback

The EB environment references EC2 key pair `handy-v3`. `eb ssh` only works with
the matching private key. Do not create a different private key with the same
filename.

Safe options are:

1. recover the original `handy-v3` private key and place it in the local SSH
   key directory with restricted permissions; or
2. configure a new EC2 key pair on the EB environment and perform a rolling
   instance replacement.

After connecting:

```bash
sudo -E bash /var/app/current/scripts/run_eb_subscription_maintenance.sh cleanup-dry
sudo -E bash /var/app/current/scripts/run_eb_subscription_maintenance.sh cleanup-write
```

SSM is preferred because it avoids distributing SSH private keys and creates an
AWS audit trail.

## Logs and verification

Look for these structured events in Elastic Beanstalk/CloudWatch application
logs:

- `subscription_reconciliation_completed`
- `subscription_access_reconciled`
- `subscription_reconciliation_failed`
- `subscription_access_verification_failed`

Useful EB commands:

```bash
eb status
eb logs --all
```

Manual SSM command output is available in Systems Manager Run Command and via
`aws ssm get-command-invocation`.

## Is an immediate manual cleanup required?

Not strictly. Once the subscription fix is deployed:

- nightly reconciliation self-heals stale Stripe-linked active records by the
  next successful `06:30 UTC` run; and
- booking POST self-heals a stale customer immediately when they attempt to
  create a booking.

Run the manual dry run after deployment if immediate visibility is desired.
Apply manual cleanup only after reviewing its proposed changes.
