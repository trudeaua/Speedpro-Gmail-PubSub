# Structured Logging Across Services and Handlers

## Goal

Replace the current mix of `console.log/warn/error` and `util.debuglog` with a structured JSON logger (pino) across all three Lambda handlers and all five services, carrying per-invocation correlation IDs so CloudWatch can be filtered by `historyId`, `messageId`, or `awsRequestId`.

## Why

Today each service logs in its own style. `drive.service.ts` uses `util.debuglog('DRIVE_SERVICE')` which is silent unless `NODE_DEBUG` is set. `gmail.service.ts` has a stray `console.log(response.data)` in `watchUser`. The handlers and `corebridge_processor.service.ts` use ad-hoc `console.log/warn/error`. There are no correlation IDs, so tracing "all logs for historyId X" across the webhook → SQS → processor flow requires eyeballing timestamps.

## Non-goals

- No centralized log aggregation (Datadog, Logtail, etc.) — CloudWatch only.
- No log shipping or metric extraction pipelines.
- No changes to retention or subscription filters.
- No removal of the existing comments / JSDoc.

## Scope

In:
- All files under `src/services/` (`auth`, `drive`, `file`, `gmail`, `corebridge_processor`).
- All three handler entry points: `webhook.ts`, `watcher.ts`, `processor.ts`.
- Service tests inherit a silent logger via `NODE_ENV=test`; no test rewrites required.

Out:
- `scripts/` helper scripts.
- Build tooling, `serverless.yml`, esbuild config.

## Design

### Logger factory

New file `src/services/logger.service.ts`:

```ts
import pino, { type Logger } from 'pino';

const isOffline = Boolean(process.env.IS_OFFLINE);
const isTest = process.env.NODE_ENV === 'test';

export const rootLogger: Logger = pino({
  level: process.env.LOG_LEVEL ?? (isTest ? 'silent' : 'info'),
  base: { service: 'gmail-pubsub' },
  ...(isOffline
    ? {
        transport: {
          target: 'pino-pretty',
          options: { translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' }
        }
      }
    : {}),
  redact: { paths: ['*.private_key', '*.client_email'], remove: true },
  formatters: { level: (label) => ({ level: label }) }
});

export type { Logger };
```

Characteristics:
- JSON in production (CloudWatch parses structured fields for filter patterns).
- `pino-pretty` when `IS_OFFLINE=true` (serverless-offline sets this automatically).
- `silent` level when `NODE_ENV=test` so jest output stays clean.
- `LOG_LEVEL` env var override (flip to `debug` to see fine-grained events without redeploying).
- Redaction paths scrub `private_key` / `client_email` as a safety net if an auth key ever lands on a log line.
- `formatters.level` renders levels as strings (`"info"`) instead of pino's default numeric codes.

### Dependencies

Add `pino` to `dependencies` and `pino-pretty` to `devDependencies` in `package.json`.

### Logger threading

Handlers create a per-invocation child logger at the start of the invocation and pass it into each service:

```ts
// processor.ts
export const handler = async (event: SQSEvent, context: Context): Promise<void> => {
  const [record] = event.Records;
  const { historyId: rawHistoryId } = JSON.parse(record.body) as { ... };
  const historyId = String(rawHistoryId);

  const log = rootLogger.child({ awsRequestId: context.awsRequestId, historyId });

  const auth = await new AuthService(log).authorize();
  const corebridge = new CorebridgeProcessorService(auth, folderCache, log);
  const gmail = new GmailService(auth, log);
  const file = new FileService(log);
  // ...
};
```

Each service accepts an optional `logger?: Logger` constructor arg (defaulting to `rootLogger`) and binds its own `service` tag:

```ts
public constructor(auth: JWT, folderCache: Map<...>, logger: Logger = rootLogger) {
  this.log = logger.child({ service: 'DriveService' });
  // ...
}
```

Optional + default means existing test setups (`new AuthService()`, `new FileService()`) stay unchanged — they pick up the silent root logger automatically when `NODE_ENV=test`.

For per-message correlation inside `CorebridgeProcessorService.processMessage`, the processor creates a per-message child and passes it as a second arg:

```ts
// processor.ts, inside the loop
const msgLog = log.child({ messageId: id });
await corebridge.processMessage(gmailMessage, msgLog);
```

Signature becomes `processMessage(message: gmail_v1.Schema$Message, logger?: Logger): Promise<void>`. Defaults to `this.log` when omitted, so direct callers don't have to thread a child if they don't have one.

### Log level policy

- `info` — lifecycle events worth keeping in prod (one per meaningful business step).
- `warn` — business-reason skips (invalid sender, unknown alert, missing fields). Not an error; the system intentionally did nothing.
- `error` — thrown exceptions. Always logged as `{ err }` so pino's standard serializer captures the stack.
- `debug` — fine-grained tracing (off by default; enable by setting `LOG_LEVEL=debug`).

### Event catalog

#### `webhook.ts`
| Level | Event | Fields |
|---|---|---|
| info | `pubsub.received` | `path` |
| warn | `pubsub.invalidPayload` | `err` |
| error | `sqs.misconfigured` | — |
| info | `sqs.enqueued` | `historyId`, `emailAddress` |

#### `watcher.ts`
| Level | Event | Fields |
|---|---|---|
| info | `watch.start` | — |
| info | `watch.refreshed` | `historyId`, `expiration` |

Replaces the existing `console.log(response.data)` in `gmail.service.ts#watchUser`.

#### `processor.ts`
| Level | Event | Fields |
|---|---|---|
| info | `history.range` | `startHistoryId`, `historyId` |
| warn | `history.expired` | `startHistoryId` |
| info | `history.reset` | `currentHistoryId` |
| debug | `message.duplicate` | `messageId` |
| info | `message.processing` | `messageId`, `labelIds` |
| warn | `message.unsupportedLabel` | `messageId`, `labelIds` |
| error | `message.fetchFailed` | `messageId`, `err` |
| error | `message.processFailed` | `messageId`, `err` |
| info | `state.updated` | `historyId` |
| warn | `batch.partialFailure` | `failedCount` |

#### `auth.service.ts`
| Level | Event | Fields |
|---|---|---|
| debug | `auth.authorize.start` | — |
| debug | `auth.authorize.done` | — |

Errors bubble; caller logs them.

#### `file.service.ts`
| Level | Event | Fields |
|---|---|---|
| debug | `s3.getObject.start` | `key` |
| debug | `s3.getObject.done` | `key`, `bytes` |
| debug | `s3.putObject.done` | `key`, `bytes` |

#### `gmail.service.ts`
| Level | Event | Fields |
|---|---|---|
| debug | `gmail.getProfile` | — |
| debug | `gmail.listHistory.start` | `startHistoryId` |
| debug | `gmail.listHistory.done` | `historyCount` |
| debug | `gmail.getMessage` | `messageId` |
| info | `gmail.watchUser.done` | `historyId`, `expiration` |

#### `drive.service.ts`
Replaces `util.debuglog('DRIVE_SERVICE')`.

| Level | Event | Fields |
|---|---|---|
| debug | `drive.folder.cacheHit` | `parentFolderId`, `folderName` |
| debug | `drive.folder.cacheMiss` | `parentFolderId`, `folderName` |
| debug | `drive.folder.exists` | `parentFolderId`, `folderName`, `folderId` |
| info | `drive.folder.created` | `parentFolderId`, `folderName`, `folderId` |

#### `corebridge_processor.service.ts`
| Level | Event | Fields |
|---|---|---|
| warn | `message.invalidSender` | `from`, `subject` |
| info | `message.alert` | `alert` |
| warn | `message.alert.unknown` | `alert` |
| warn | `customer.invalidName` | `customer` |
| warn | `estimate.missingFields` | `customer`, `reference`, `occurred`, `description` |
| info | `customer.directory.ready` | `customer` |
| info | `estimate.directory.ready` | `customer`, `reference`, `dirName` |

### PII / redaction

Customer names and sender email addresses are logged verbatim. The data lives in the user's own Gmail inbox and flows only to the user's own CloudWatch; this is an internal tool, not a multi-tenant service. Redaction is limited to the `private_key` / `client_email` safety net in the root config.

Raw email body `content` and full `subject` bodies are not logged — only the structured header fields extracted by `ContentHeaders` parsing.

### Testing

- Jest sets `NODE_ENV=test` automatically, so all tests run with `silent` level; no test output changes.
- No test rewrites required because `logger?` is optional on every service constructor.
- Tests can still assert on `console.warn`/`console.error` spies where those exist today; those assertions will be removed alongside the replaced calls. Tests that depended on console output (if any) will need to either: (a) drop the assertion, or (b) assert on the pino-injected logger via a spy. We will audit existing tests once implementation begins and adjust in-place.

### Migration

All `console.*` calls in services and handlers get replaced in a single pass. No `util.debuglog` left behind. No feature flag / gradual rollout — single PR, single deploy.

## Open risks

- **Cold start cost**: `pino` is small (~10kb) but pulls a few transitive deps. Expected cold-start delta is negligible for a Lambda that already loads `googleapis`. If measured delta is > 50ms, we'll revisit the transport config.
- **`pino-pretty` in prod**: Excluded via `IS_OFFLINE` gate. If `IS_OFFLINE` leaks into prod (shouldn't), the transport worker would still succeed but add noise — acceptable failure mode.
- **Log volume**: `drive.folder.created` at `info` fires per new folder, so a first-time estimate with no cached folders produces ~10 info lines. Still cheap at CloudWatch's pricing and useful for audit.
