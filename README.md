# Speedpro Gmail PubSub

Watches a Gmail mailbox through GCP Pub/Sub and creates the matching client/job folder
structure in a Google Shared Drive. Runs on AWS Lambda via Serverless Framework v3.

It reacts to Corebridge alert emails: "New Customer" creates the customer folder, "New Estimate"
creates the job folder and its standard subfolders.

## How it works

```
Gmail ──watch──► GCP Pub/Sub ──push──► API Gateway POST /pubsub
                                            │
                                         webhook (validates + enqueues)
                                            │
                                          SQS ──► processor ──► Gmail history ──► Google Drive
                                                      │
                                                   S3 state.json (last historyId)
```

- **webhook** — parses the Pub/Sub push, pulls `emailAddress` and `historyId` out of the base64
  payload, drops it on SQS and returns immediately. Nothing slow happens here.
- **processor** — SQS-triggered, batch size 1. Reads the last `historyId` from S3, asks Gmail for
  everything since then, filters to the configured labels, and hands each message to the Corebridge
  processor. Throws on failure so SQS retries (3 attempts, then the DLQ).
- **watcher** — scheduled daily. Re-registers the Gmail watch. Gmail drops the watch after 7 days,
  so this has to keep running.

Folders created for a new estimate, under `<First letter>/<Customer>/<YYYY.MM>_<Ref>_<Description>`:
`1_Artwork/Assets`, `2_Permits`, `3_Photos/{Survey,Progress,Completion}`, `4_Production`, `5_Quotes`.

If the stored `historyId` is older than ~30 days Gmail returns 404. The processor detects that,
resets state to the current `historyId` and moves on. Messages in the gap are not recovered.

## Prerequisites

- Node.js 22
- Yarn
- An AWS account with credentials configured locally
- A Google Workspace domain you can administer
- A GCP project with the Pub/Sub API enabled

## Setup

### 1. Install

```bash
yarn
```

### 2. Google service account

Follow [docs/GCP_SERVICE_ACCOUNT.md](docs/GCP_SERVICE_ACCOUNT.md). It covers creating the service
account, enabling domain-wide delegation, authorizing scopes in Workspace Admin, and storing the
JSON key in AWS Secrets Manager. Auth uses domain-wide delegation, not OAuth refresh tokens.

### 3. AWS resources

Create these before the first deploy:

- **Secrets Manager secret** holding the service account JSON (`SECRET_TOKEN_ID`).
- **S3 bucket** for state (`S3_STATE_BUCKET`), seeded with a `state.json`:
  ```bash
  echo '{"historyId":"1"}' > state.json
  aws s3 cp state.json s3://<your-bucket>/state.json
  ```
  Use a real current `historyId` if you have one. `1` will be treated as expired on the first run
  and reset to current, which is fine for a cold start.
- **IAM policy** granting the Lambdas `s3:GetObject`/`s3:PutObject` on the state bucket and
  `secretsmanager:GetSecretValue` on the secret. `serverless.yml` attaches it by ARN
  (`GmailPubSubRuntimePolicy`) — update that ARN for your account. SQS permissions are added by
  the stack itself.

The SQS queue, DLQ and log groups are created by the deploy.

### 4. Environment

Copy `.env.example` to `.env` and fill it in:

| Variable | What it is |
| --- | --- |
| `GCP_PUBSUB_TOPIC` | Full topic name, `projects/<project>/topics/<topic>` |
| `DRIVE_ID` | Google Shared Drive ID that folders get created in |
| `GOOGLE_IMPERSONATE_EMAIL` | Workspace user the service account impersonates |
| `SECRET_TOKEN_ID` | Secrets Manager secret ID holding the service account key |
| `S3_STATE_BUCKET` | Bucket holding `state.json` |
| `GMAIL_LABEL_IDS` | Comma-separated Gmail label IDs to watch |
| `ALERT_EMAIL_WHITELIST` | Comma-separated senders whose alerts are processed |

### 5. Deploy

```bash
yarn deploy
```

Creates three functions: `webhook`, `processor`, `watcher`. Note the API Gateway URL from the output.

### 6. Pub/Sub topic and subscription

Follow https://pcarion.com/posts/gmail-pubsub-aws-lambda/#enable-the-cloud-pubsub-api.

- Grant `gmail-api-push@system.gserviceaccount.com` the Pub/Sub Publisher role on the topic.
- Create a push subscription pointing at `<api-gateway-url>/pubsub`.

### 7. Start the watch

Invoke `watcher` once to register the Gmail watch. After that the daily schedule keeps it alive.

```bash
aws lambda invoke --function-name gmailpubsub-production-watcher /dev/stdout
```

## Development

```bash
yarn start          # serverless-offline
yarn build          # esbuild via etsc
yarn test           # jest
yarn prettier:fix   # format src/
```

Path alias: `@services/*` → `src/services/*`.

## CI

`.github/workflows/deploy.yml` runs tests then deploys on push to `main`. It authenticates to AWS
with OIDC (`AWS_ROLE_ARN` secret) and takes the environment values from repository variables, so
those need to be set in GitHub as well as in your local `.env`.

## Operational notes

- The watch must be renewed at least every 7 days or the whole thing silently stops.
- Failed messages land in `gmail-pubsub-dlq` after 3 attempts. Messages retain for 14 days there.
- Log retention is 7 days on all three functions.
- Region is `ca-central-1`.
