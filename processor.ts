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
 * Retrieves the historyId from the S3 state file.
 */
async function getStoredHistoryId(fileService: FileService): Promise<string> {
  const stateObject = await fileService.getObject(stateFileName);
  let state: { historyId?: number | string } | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    state = JSON.parse(stateObject);
  } catch {
    throw new Error('Failed to parse state file');
  }
  if (state?.historyId === undefined || (typeof state.historyId !== 'string' && typeof state.historyId !== 'number')) {
    throw new Error('Failed to retrieve history id from state file');
  }
  return `${state.historyId}`;
}

/**
 * Updates the S3 state file with the given historyId.
 */
async function updateStoredHistoryId(fileService: FileService, historyId: string): Promise<void> {
  await fileService.putObject(stateFileName, JSON.stringify({ historyId }));
}

/**
 * Processor Lambda handler. Triggered by SQS with concurrency 1.
 * Fetches Gmail history, processes messages, and updates state.
 * Throws on failure so SQS retries.
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

  const startHistoryId = await getStoredHistoryId(fileService);
  console.log(`Processing history from ${startHistoryId} to ${historyId}`);

  const { data } = await gmailService.listHistory(startHistoryId);
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

  const finalHistoryId = BigInt(historyId) > BigInt(startHistoryId) ? historyId : startHistoryId;
  await updateStoredHistoryId(fileService, finalHistoryId);
  console.log(`State updated to historyId=${finalHistoryId}`);

  boundCache(messageCache, MAX_CACHE_SIZE);
  boundCache(folderCache, MAX_CACHE_SIZE);
};
