# Backend Deployment

The Profixter backend is deployed separately from the frontend.

- Frontend stays on Vercel.
- Backend deploys to the existing AWS Elastic Beanstalk environment.
- Pushing the backend repo `main` branch triggers `.github/workflows/deploy-eb.yml`.

## One-Time GitHub Setup

1. Create a new empty GitHub repository for the backend.
2. Push this `BackEnd` directory to that repository.
3. In GitHub, open:
   `Settings` -> `Secrets and variables` -> `Actions` -> `New repository secret`
4. Add:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION`
   - `EB_APPLICATION_NAME`
   - `EB_ENVIRONMENT_NAME`

Production environment variables such as database URLs, JWT secrets, Stripe keys, and mail credentials remain in AWS Elastic Beanstalk environment configuration. They do not belong in GitHub secrets unless they are strictly deployment credentials.

## What the Workflow Does

On every push to `main`, and on manual `workflow_dispatch` runs, the workflow:

1. Checks out the backend repo.
2. Verifies required deployment secrets exist.
3. Sets up Node from `package.json`.
4. Runs `npm ci`.
5. Runs `npm test` if a test script exists.
6. Runs `npm run lint` if a lint script exists.
7. If no tests exist, runs `node --check` over backend JavaScript entry points.
8. Builds a clean Elastic Beanstalk zip.
9. Uploads that zip to the existing Elastic Beanstalk S3 bucket.
10. Creates a new EB application version named from the Git commit SHA.
11. Updates the configured EB environment to that version.
12. Waits for the deployment to finish and prints environment health summary.

The deployment bundle excludes `.env`, `.env.*`, `node_modules`, logs, build output, temporary folders, archive files, and test/spec files.

## EB Package Expectations

The repository already contains the expected runtime files:

- `package.json`
- `package-lock.json`
- `server.js`
- `Procfile`

Elastic Beanstalk starts the app with:

```bash
node server.js
```

## Manual Re-Run

To re-run a failed deployment:

1. Open the backend GitHub repository.
2. Go to `Actions`.
3. Open `Deploy Backend to Elastic Beanstalk`.
4. Select the failed run and choose `Re-run jobs`.

You can also trigger a fresh deployment manually from the workflow page with `Run workflow`.

## Rollback

To roll back in Elastic Beanstalk:

1. Open AWS Elastic Beanstalk.
2. Open the Profixter backend application.
3. Open `Application versions`.
4. Select the previous healthy version.
5. Choose `Deploy`.

Version labels use the Git commit SHA, so each deployment maps back to an exact backend commit.
