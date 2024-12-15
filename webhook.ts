import type { PutObjectCommandOutput } from '@aws-sdk/client-s3';
import type { APIGatewayEvent } from 'aws-lambda';
import dotenv from 'dotenv';
import type { drive_v3, gmail_v1 } from 'googleapis';

import { AuthService } from '@services/auth.service';
import { CorebridgeProcessorService } from '@services/corebridge_processor.service';
import { FileService } from '@services/file.service';
import { GmailService } from '@services/gmail.service';

dotenv.config();

const stateFileName = 'state.json';

const folderCache = new Map<string, drive_v3.Schema$File>();
const messageCache = new Map<string, gmail_v1.Schema$Message>();
/**
 * Retrieves the history id from the state file.
 *
 * @param {FileService} fileService - The file service used to interact with the S3 bucket.
 * @returns {Promise<string>} The history id retrieved from the state file.
 * @throws {Error} If the history id is not present, not a string or number, or cannot be parsed.
 */
async function retrieveHistoryIdFromStateFile(fileService: FileService): Promise<string> {
  // Retrieve the state object from the S3 bucket
  const stateObject = await fileService.getObject(stateFileName);
  // Parse the state object from JSON format
  let state: { historyId?: number | string } | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    state = JSON.parse(stateObject);
  } catch (err) {
    throw new Error('Failed to parse state file');
  }
  // Check if the history id is present and if it is a string or number
  if (state?.historyId === undefined || (typeof state.historyId !== 'string' && typeof state.historyId !== 'number')) {
    throw new Error('Failed to retrieve history id from state file');
  }
  // Return the history id as a string
  return `${state.historyId}`;
}

/**
 * Updates the state file with the provided history id.
 *
 * @param {FileService} fileService - The file service used to interact with the S3 bucket.
 * @param {string} historyId - The history id to be stored in the state file.
 * @returns {Promise<any>} A promise that resolves when the state file is successfully updated.
 */
async function updateState(fileService: FileService, historyId: string): Promise<PutObjectCommandOutput> {
  // Convert the history id to a JSON string and store it in the state file
  // using the provided file service.
  // This function returns a Promise that resolves when the state file is updated.
  return fileService.putObject(stateFileName, JSON.stringify({ historyId }));
}

/**
 * Parses the event payload and extracts the email address and history id.
 *
 * @param {APIGatewayEvent} event - The API Gateway event containing the payload.
 * @returns {Object} - An object with the email address and history id.
 * @throws {Error} - If the payload is invalid or missing either the email address or history id.
 */
function parseEvent(event: APIGatewayEvent): {
  emailAddress: string;
  historyId: string;
} {
  // Extract the payload from the API Gateway event.
  // If the payload is a string, parse it as JSON. Otherwise, use it as is.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const payload = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;

  try {
    // Parse the base64 encoded payload and extract the email address and history id.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const { emailAddress, historyId }: { emailAddress: string; historyId: string } = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
      Buffer.from(payload.message.data, 'base64').toString('utf8')
    );

    // Return an object with the email address and history id.
    return { emailAddress, historyId };
  } catch (err) {
    // Log and re-throw any error that occurs while parsing the payload.
    console.error(err);
    throw new Error('Failed to parse payload');
  }
}
/**
 * Main Lambda handler function.
 *
 * @param {APIGatewayEvent} event - The event triggering the Lambda function.
 * @returns {Promise<Object>} - A Promise that resolves to an object with a statusCode and a body.
 */
export const handler = async (event: APIGatewayEvent): Promise<{ statusCode: number; body: string }> => {
  console.log(event);
  // Create authentication and file service instances
  const authService = new AuthService();
  const auth = await authService.authorize();
  const corebridgeProcessorService = new CorebridgeProcessorService(auth, folderCache);
  const gmailService = new GmailService(auth);
  const fileService = new FileService();

  // Parse the event payload and extract the history ID
  const { historyId } = parseEvent(event);

  // Retrieve the start history ID from the state file
  const startHistoryId = await retrieveHistoryIdFromStateFile(fileService);
  console.log(startHistoryId, historyId);
  // List the Gmail message history
  const { data } = await gmailService.listHistory(startHistoryId);

  // Loop through the new messages in the history
  const { history = [] } = data;
  for (const { messagesAdded } of history) {
    if (!messagesAdded) continue;
    for (const { message } of messagesAdded) {
      if (!message?.id) continue;
      // Try to prevent the same message from being processed more than once
      if (messageCache.has(message.id)) {
        console.log(`Message ${message.id} has already been received. Skipping.`);
        continue;
      } else {
        messageCache.set(message.id, message);
      }
      const { id, labelIds } = message;
      console.log(`Processing message ${id} with labels ${labelIds?.join(', ')}`);
      // Check labels. Only process messages with a supported label
      const isValidLabel = (labelIds ?? []).some((labelId) => gmailService.getLabelIds().includes(labelId));
      if (!isValidLabel) {
        console.warn(`Message ${id} does not have a supported label. Skipping.`);
        continue;
      }

      // Handle email doesn't exist
      let gmailMessage: gmail_v1.Schema$Message;
      try {
        gmailMessage = await gmailService.getMessage(id);
      } catch (err) {
        if (err instanceof Error) {
          console.error(err.message);
        }
        continue;
      }

      // Process the email message
      try {
        await corebridgeProcessorService.processMessage(gmailMessage);
      } catch (err) {
        if (err instanceof Error) {
          console.error(err.message);
        }
        continue;
      }
    }
  }

  // Update the state file with the new history ID
  await updateState(fileService, historyId);

  // Return a success response
  return {
    statusCode: 200,
    body: JSON.stringify('Messages processed successfully')
  };
};
