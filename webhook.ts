import { APIGatewayEvent, Context } from "aws-lambda";
import dotenv from "dotenv";
import { AuthService } from "./src/services/auth.service";
import { FileService } from "./src/services/file.service";
import { CorebridgeProcessorService } from "./src/services/corebridge_processor.service";
import { GmailService } from "./src/services/gmail.service";

dotenv.config();

const stateFileName = "state.json";

/**
 * Retrieves the history id from the state file.
 *
 * @param {FileService} fileService - The file service used to interact with the S3 bucket.
 * @returns {Promise<string>} The history id retrieved from the state file.
 * @throws {Error} If the history id is not present or not a string or number.
 */
async function retrieveHistoryIdFromStateFile(
  fileService: FileService
): Promise<string> {
  // Retrieve the state object from the S3 bucket
  const stateObject = await fileService.getObject(stateFileName);
  // Parse the state object from JSON format
  const state = JSON.parse(stateObject);
  // Check if the history id is present and if it is a string or number
  if (
    !state.historyId ||
    (typeof state.historyId !== "string" && typeof state.historyId !== "number")
  ) {
    // Throw an error if the history id is not present or not a string or number
    throw new Error("Failed to retrieve history id from state file");
  }
  // Return the history id as a string
  return state.historyId.toString();
}

/**
 * Updates the state file with the provided history id.
 *
 * @param {FileService} fileService - The file service used to interact with the S3 bucket.
 * @param {string} historyId - The history id to be stored in the state file.
 * @returns {Promise<any>} A promise that resolves when the state file is successfully updated.
 */
async function updateState(
  fileService: FileService,
  historyId: string
): Promise<any> {
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
function parseEvent(event: APIGatewayEvent) {
  // Extract the payload from the API Gateway event.
  // If the payload is a string, parse it as JSON. Otherwise, use it as is.
  let payload: any;
  if (typeof event.body === "string") {
    payload = JSON.parse(event.body);
  } else {
    payload = event.body;
  }

  try {
    // Parse the base64 encoded payload and extract the email address and history id.
    const { emailAddress, historyId } = JSON.parse(
      Buffer.from(payload.message.data, "base64").toString("utf8")
    );

    // Throw an error if either the email address or history id is missing.
    if (!emailAddress || !historyId) {
      throw new Error(
        "Invalid payload. Missing email address and/or history id"
      );
    }

    // Return an object with the email address and history id.
    return { emailAddress, historyId };
  } catch (err) {
    // Log and re-throw any error that occurs while parsing the payload.
    console.error(err);
    throw new Error("Failed to parse payload");
  }
}
/**
 * Main Lambda handler function.
 *
 * @param {APIGatewayEvent} event - The event triggering the Lambda function.
 * @param {Context} _context - The Lambda function runtime context.
 * @returns {Promise<Object>} - A Promise that resolves to an object with a statusCode and a body.
 */
export const handler = async (
  event: APIGatewayEvent,
  _context: Context
): Promise<{ statusCode: number; body: string }> => {
  console.log(event);
  // Create authentication and file service instances
  const authService = new AuthService();
  const auth = await authService.authorize();
  const corebridgeProcessorService = new CorebridgeProcessorService(auth);
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
      const { id } = message;
      const emailMessage = await gmailService.getMessage(id);
      // Process the email message
      await corebridgeProcessorService.processMessage(emailMessage);
    }
  }

  // Update the state file with the new history ID
  await updateState(fileService, historyId);

  // Return a success response
  return {
    statusCode: 200,
    body: JSON.stringify("Messages processed successfully"),
  };
};
