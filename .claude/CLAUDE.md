# Speedpro Gmail PubSub

GCP PubSub Gmail Watcher on AWS Lambda (Serverless Framework v3). Parses specific email messages and creates folders in Google Drive based on email content.

## Tech Stack

- **Runtime:** Node.js 22, TypeScript 5.9
- **Framework:** Serverless Framework v3 (AWS Lambda)
- **Build:** esbuild via `esbuild-node-tsc` (`etsc`)
- **Bundling:** serverless-bundle
- **AWS Services:** Lambda, API Gateway, S3, Secrets Manager
- **Google APIs:** Gmail (PubSub), Google Drive
- **Region:** ca-central-1

## Project Structure

- `webhook.ts` — Lambda handler for PubSub webhook (POST /pubsub)
- `watcher.ts` — Lambda handler for daily Gmail watch renewal (scheduled, rate 1 day)
- `src/services/` — Business logic services
- `scripts/` — Setup scripts (e.g., Google auth initialization)

## Commands

- `yarn` — Install dependencies
- `yarn build` — Build with etsc
- `yarn start` — Run locally with serverless-offline
- `yarn deploy` — Deploy to AWS (`serverless deploy`)
- `yarn prettier:fix` — Format source files

## Path Aliases

- `@services/*` → `src/services/*`

## Environment Variables

Configured via `.env` and referenced in `serverless.yml`:
- `GCP_PUBSUB_TOPIC` — GCP PubSub topic name
- `DRIVE_ID` — Target Google Drive ID

## Notes

- Google auth tokens are stored in AWS Secrets Manager
- The watcher must run at least once every 7 days to keep the Gmail watch active
- Log retention is set to 7 days for both Lambda functions
