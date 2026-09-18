import type { SQSEvent } from 'aws-lambda';
import dotenv from 'dotenv';
import type { drive_v3, gmail_v1 } from 'googleapis';

import { AuthService } from '@services/auth.service';
import { CorebridgeProcessorService } from '@services/corebridge_processor.service';
import { FileService } from '@services/file.service';
import { GmailService } from '@services/gmail.service';

dotenv.config();

const stateFileName = 'state.json';
const MAX_CACHE_SIZE = 1000;
const MAX_STATE_WRITE_ATTEMPTS = 5;

/**
 * The stored historyId plus the ETag it was read at.
 */
interface StoredState {
  historyId: string;
  etag?: string;
}

const folderCache = new Map<string, drive_v3.Schema$File>();
const messageCache = new Map<string, gmail_v1.Schema$Message>();

/**
 * Evicts oldest entries from a Map when it exceeds maxSize.
 */
function boundCache<K, V>(cache: Map<K, V>, maxSize: number): void {
  if (cache.size <= maxSize) return;
  const excess = cache.size - maxSize;
  const keys = cache.keys();
  for (let i = 0; i < excess; i++) {
    const next = keys.next();
    if (!next.done) cache.delete(next.value);
  }
}

/**
 * Retrieves the historyId from the S3 state file, along with the ETag to write back against.
 */
async function getStoredState(fileService: FileService): Promise<StoredState> {
  const { body, etag } = await fileService.getObject(stateFileName);
  let state: { historyId?: number | string } | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    state = JSON.parse(body);
  } catch {
    throw new Error('Failed to parse state file');
  }
  if (state?.historyId === undefined || (typeof state.historyId !== 'string' && typeof state.historyId !== 'number')) {
    throw new Error('Failed to retrieve history id from state file');
  }
  return { historyId: `${state.historyId}`, etag };
}

/**
 * True when S3 rejected a conditional write because the object changed underneath us.
 * 412 is a straight ETag mismatch; 409 is S3 reporting another conditional write in flight.
 */
function isPreconditionFailure(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const { name } = err as { name?: string };
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'PreconditionFailed' || name === 'ConditionalRequestConflict' || status === 412 || status === 409;
}

/**
 * Advances the stored historyId, never backwards.
 *
 * The write is conditional on the ETag the state was read at, so a slower invocation
 * holding an older historyId can't clobber a newer one. On a rejected write we re-read
 * and re-decide rather than forcing our value in: if someone else already moved the
 * state past us there is nothing left to do.
 */
async function commitHistoryId(fileService: FileService, candidate: string, state: StoredState): Promise<void> {
  let { historyId: stored, etag } = state;

  for (let attempt = 1; attempt <= MAX_STATE_WRITE_ATTEMPTS; attempt++) {
    if (BigInt(candidate) <= BigInt(stored)) {
      console.log(`State already at historyId=${stored}. Nothing to advance.`);
      return;
    }

    try {
      await fileService.putObject(stateFileName, JSON.stringify({ historyId: candidate }), { ifMatch: etag });
      console.log(`State updated to historyId=${candidate}`);
      return;
    } catch (err) {
      if (!isPreconditionFailure(err)) {
        throw err;
      }
      console.warn(`State changed during attempt ${attempt}. Re-reading and retrying.`);
      ({ historyId: stored, etag } = await getStoredState(fileService));
    }
  }

  throw new Error(`Failed to commit historyId=${candidate} after ${MAX_STATE_WRITE_ATTEMPTS} attempts`);
}

/**
 * Processor Lambda handler.
 *
 * Fetches Gmail history, processes messages, and updates state. Throws on failure so SQS retries.
 *
 * Invocations are serialised by the FIFO queue (every message uses the same MessageGroupId),
 * which is what keeps two runs from working the same history window and creating the same Drive
 * folders twice. The conditional state write below is the backstop for anything that arrives
 * outside that ordering, such as a DLQ redrive or a manual invoke.
 */
export const handler = async (event: SQSEvent): Promise<void> => {
  // SQS event contains records; with batchSize 1 there's exactly one
  const [record] = event.Records;
  const { historyId: rawHistoryId } = JSON.parse(record.body) as { emailAddress: string; historyId: string | number };
  const historyId = String(rawHistoryId);

  const authService = new AuthService();
  const auth = await authService.authorize();
  const corebridgeProcessorService = new CorebridgeProcessorService(auth, folderCache);
  const gmailService = new GmailService(auth);
  const fileService = new FileService();

  const state = await getStoredState(fileService);
  const startHistoryId = state.historyId;
  console.log(`Processing history from ${startHistoryId} to ${historyId}`);

  let data: Awaited<ReturnType<typeof gmailService.listHistory>>['data'];
  try {
    ({ data } = await gmailService.listHistory(startHistoryId));
  } catch (err) {
    // Gmail returns 404 when historyId is too old (>30 days). Reset to current state.
    if (err instanceof Error && 'code' in err && (err as { code: number }).code === 404) {
      console.warn('History expired. Resetting to current historyId. Messages in the gap are lost.');
      const profile = await gmailService.getProfile();
      await commitHistoryId(fileService, String(profile.historyId), state);
      return;
    }
    throw err;
  }

  const { history = [] } = data;

  let hasFailure = false;

  for (const { messagesAdded } of history) {
    if (!messagesAdded) continue;
    for (const { message } of messagesAdded) {
      if (!message?.id) continue;

      if (messageCache.has(message.id)) {
        console.log(`Message ${message.id} already seen. Skipping.`);
        continue;
      }

      const { id, labelIds } = message;
      console.log(`Processing message ${id} with labels ${labelIds?.join(', ')}`);

      const isValidLabel = (labelIds ?? []).some((labelId) => gmailService.getLabelIds().includes(labelId));
      if (!isValidLabel) {
        console.warn(`Message ${id} does not have a supported label. Skipping.`);
        continue;
      }

      let gmailMessage: gmail_v1.Schema$Message;
      try {
        gmailMessage = await gmailService.getMessage(id);
      } catch (err) {
        console.error(`Failed to fetch message ${id}:`, err instanceof Error ? err.message : err);
        hasFailure = true;
        continue;
      }

      try {
        await corebridgeProcessorService.processMessage(gmailMessage);
        messageCache.set(message.id, message);
      } catch (err) {
        console.error(`Failed to process message ${id}:`, err instanceof Error ? err.message : err);
        hasFailure = true;
        continue;
      }
    }
  }

  if (hasFailure) {
    throw new Error('One or more messages failed to process. SQS will retry.');
  }

  await commitHistoryId(fileService, historyId, state);

  boundCache(messageCache, MAX_CACHE_SIZE);
  boundCache(folderCache, MAX_CACHE_SIZE);
};
