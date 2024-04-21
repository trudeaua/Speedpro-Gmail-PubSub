import type { OAuth2Client } from 'google-auth-library';
import { gmail_v1, google } from 'googleapis';
import type { GaxiosPromise } from 'googleapis/build/src/apis/gmail';

/**
 * Represents a parsed Gmail message.
 */
export interface ParsedMessage {
  /**
   * The subject of the message.
   */
  subject?: string;

  /**
   * The content of the message.
   */
  content?: string;

  /**
   * The sender of the message.
   */
  from?: string;

  /**
   * The date of the message.
   */
  date?: string;
}

/**
 * A service to interact with Gmail API.
 */
export class GmailService {
  /**
   * The Gmail API client.
   */
  private readonly gmail: gmail_v1.Gmail;

  /**
   * Constructs a GmailService instance.
   *
   * @param {OAuth2Client} auth - The OAuth2 client for authentication.
   */
  public constructor(auth: OAuth2Client) {
    this.gmail = google.gmail({ version: 'v1', auth });
  }

  /**
   * Parses a Gmail message into a more readable format.
   *
   * @param {gmail_v1.Schema$Message} message - The Gmail message.
   * @return {ParsedMessage} The parsed message.
   */
  public static parseMessage(message: gmail_v1.Schema$Message): ParsedMessage {
    // Finds the plain text part of the message.
    const textHtmlPart = message.payload?.parts?.find((part) => part.mimeType === 'text/html');

    /**
     * Finds the value of a header in the message.
     *
     * @param {string} name - The name of the header.
     * @return {string | undefined} The value of the header, or undefined if not found.
     */
    function findHeader(name: string): string | undefined {
      const result = message.payload?.headers?.find((header) => header.name === name)?.value ?? undefined;
      return result;
    }

    // Gets the subject, from, and date of the message.
    const subject = findHeader('Subject');
    const from = findHeader('From');
    const date = findHeader('Date');

    // Gets the contents of the message.
    let content: string | undefined;
    if (textHtmlPart?.body?.data) {
      content = Buffer.from(textHtmlPart.body.data, 'base64').toString('utf8');
    }
    const result: ParsedMessage = {
      subject,
      content: content?.trim(),
      from,
      date
    };
    return result;
  }

  /**
   * Lists the Gmail message history.
   *
   * @param {string} startHistoryId - The id of the start history.
   * @return {Promise<gmail_v1.Schema$ListHistoryResponse>} A promise that resolves to the list of history messages.
   */
  public async listHistory(startHistoryId: string): GaxiosPromise<gmail_v1.Schema$ListHistoryResponse> {
    return this.gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      maxResults: 10
    });
  }

  /**
   * Gets a Gmail message.
   *
   * @param {string} messageId - The id of the message.
   * @return {Promise<gmail_v1.Schema$Message>} A promise that resolves to the message.
   */
  public async getMessage(messageId: string): Promise<gmail_v1.Schema$Message> {
    const response = await new Promise<gmail_v1.Schema$Message>((resolve, reject) =>
      this.gmail.users.messages
        .get({
          userId: 'me',
          id: messageId
        })
        .then((res) => {
          resolve(res.data);
        })
        .catch((err) => {
          reject(err);
        })
    );
    return response;
  }

  /**
   * Watches for changes in the Gmail inbox and notifies to a Pub/Sub topic.
   *
   * @return {Promise<void>} A promise that resolves when the watch is set up.
   */
  public async watchUser(): Promise<void> {
    return this.gmail.users.watch(
      {
        userId: 'me',
        requestBody: {
          labelIds: ['INBOX'],
          topicName: process.env.GCP_PUBSUB_TOPIC
        }
      },
      (err) => {
        if (err) {
          throw err;
        }
      }
    );
  }
}
