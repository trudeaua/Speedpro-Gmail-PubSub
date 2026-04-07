import dayjs from 'dayjs';
import type { JWT } from 'google-auth-library';
import type { drive_v3 } from 'googleapis';
import type { gmail_v1 } from 'googleapis/build/src/apis/gmail/v1';

import { DriveService } from '@services/drive.service';
import type { ParsedMessage } from '@services/gmail.service';
import { GmailService } from '@services/gmail.service';

type ContentHeader =
  | 'Alert'
  | 'Customer'
  | 'Description'
  | 'Event'
  | 'METADATA_DATE'
  | 'Occurred'
  | 'Reference #'
  | 'Salesperson'
  | 'SubTotal Price';
class ContentHeaders extends Map<ContentHeader, string> {}

enum CorebridgeAlert {
  NewCustomer = 'New Customer',
  NewEstimate = 'New Estimate',
  NewOrder = 'New Order'
}

export class CorebridgeProcessorService {
  private readonly driveService: DriveService;
  public constructor(auth: JWT, folderCache: Map<string, drive_v3.Schema$File>) {
    this.driveService = new DriveService(auth, folderCache);
  }

  /**
   * Checks if the given message is valid.
   *
   * A message is considered valid if it comes from a whitelisted email address
   * and is either a new customer message or a new estimate message.
   *
   * @param {ParsedMessage} message - The parsed email message.
   * @return {boolean} True if the message is valid, false otherwise.
   */
  private static isValidMessage(message: ParsedMessage): boolean {
    // Whitelisted email addresses from which valid messages can come.
    const emailWhitelist = (process.env.ALERT_EMAIL_WHITELIST ?? '').split(',').filter(Boolean);

    // Check if the message comes from a whitelisted email address.
    const isValidFrom = Boolean(message.from && emailWhitelist.some((email) => (message.from ?? '').includes(email)));

    // Return true if the message is valid, false otherwise.
    return isValidFrom;
  }

  /**
   * Processes a Gmail message.
   *
   * @param {gmail_v1.Schema$Message} message - The Gmail message.
   * @return {Promise<void>} A promise that resolves when the message is processed.
   */
  public async processMessage(message: gmail_v1.Schema$Message): Promise<void> {
    // Parse the Gmail message into a more readable format.
    const parsedMessage = GmailService.parseMessage(message);

    // Destructure the parsed message to extract the relevant fields.
    const { content = '', from = '', subject = '', date = '' } = parsedMessage;

    // Check if the message is valid.
    if (!CorebridgeProcessorService.isValidMessage(parsedMessage)) {
      // Log a warning and skip the message if it is invalid.
      console.warn('Invalid email message: ', from, subject, date, Boolean(content), 'Skipping.');
      return;
    }

    // Parse the headers of the message.
    const labels: ContentHeader[] = [
      'Alert',
      'Customer',
      'Reference #',
      'Salesperson',
      'Description',
      'Event',
      'SubTotal Price',
      'Occurred'
    ];

    const headers = new ContentHeaders();
    for (const label of labels) {
      // eslint-disable-next-line no-useless-escape
      const re = new RegExp(`${label}:\s*(.*?)\r{0,1}\n`);
      // eslint-disable-next-line no-useless-escape
      const match = re.exec(content);
      if (match) {
        const key = label;
        const value = match[1].trim().replace(/<pre>|<\/pre>/g, '');
        headers.set(key, value);
      }
    }

    // Append the date from the message metadata to the headers.
    headers.set('METADATA_DATE', date);

    // Process the message based on the alert type
    const alert = headers.get('Alert');
    switch (alert) {
      case CorebridgeAlert.NewCustomer:
        return this.processNewCustomer(headers);
      case CorebridgeAlert.NewOrder:
      case CorebridgeAlert.NewEstimate:
        return this.processNewEstimate(headers);
      default:
        console.warn(`Invalid alert "${alert}". Skipping`);
        return;
    }
  }

  /**
   * Process a new customer message and create a directory for their client files in Google Drive.
   *
   * @param {ContentHeaders} headers - The headers of the message.
   * @return {Promise<void>} A promise that resolves when the directory is created.
   */
  private async processNewCustomer(headers: ContentHeaders): Promise<void> {
    // Extract the customer name from the headers.
    const customer = headers.get('Customer');
    // Extract the first character of the customer name and convert it to uppercase.
    const beginsWith = customer?.at(0)?.toUpperCase();

    // Log a warning and skip the message if the customer name is invalid.
    if (!customer || !beginsWith) {
      console.warn('Invalid customer name. Skipping.');
      return;
    }

    // Create a directory for the customer in Google Drive.
    // The directory will be nested in "Client Files/<beginsWith>/<customer>/"
    // The sub-folders "<beginsWith>" and "<customer>" will be created if they don't exist.
    // This function call is asynchronous and returns a promise that resolves when the directory is created.
    await this.driveService.createFolders([beginsWith, customer]);
  }

  /**
   * Process a new estimate message and create a directory and subdirectories for the estimate files in Google Drive.
   *
   * @param {ContentHeaders} headers - The headers of the message.
   * @return {Promise<void>} A promise that resolves when the directory and subdirectories are created.
   */
  private async processNewEstimate(headers: ContentHeaders): Promise<void> {
    // Extract the required headers
    const customer = headers.get('Customer');
    const occurred = headers.get('METADATA_DATE') ?? headers.get('Occurred');
    const reference = headers.get('Reference #')?.split('-')[1];
    const description = headers.get('Description');

    // Log a warning and skip the message if any of the required headers are invalid.
    if (!customer || !occurred || !reference || !description) {
      console.warn('Invalid estimate. Skipping.');
      return;
    }

    // Construct the directory name
    const date = occurred ? dayjs(occurred).add(dayjs(occurred).utcOffset(), 'minutes') : undefined;
    const year = date?.get('year');
    const month = date ? (date.get('month') + 1).toString().padStart(2, '0') : undefined;
    const dirName = `${year}.${month}_${reference}_${description}`;

    // Construct the directory path
    const beginsWith = customer.at(0)?.toUpperCase();
    if (!customer || !beginsWith) {
      console.warn('Invalid customer name. Skipping.');
      return;
    }
    const directory = [beginsWith, customer, dirName];

    // Create the root directory
    await this.driveService.createFolders([...directory]);

    const folders: Record<string, string[]> = {
      '1_Artwork': ['Assets'],
      '2_Permits': [],
      '3_Photos': ['Survey', 'Progress', 'Completion'],
      '4_Production': [],
      '5_Quotes': []
    };

    // Create second layer of folders
    await Promise.all(
      Object.keys(folders).map(async (folder) => {
        await this.driveService.createFolders([...directory, folder]);
      })
    );

    // Create third layer of folders
    await Promise.all(
      Object.keys(folders).map(async (folder) => {
        // If there are subfolders, create the folder and its subfolders
        for (const subfolder of folders[folder]) {
          await this.driveService.createFolders([...directory, folder, subfolder]);
        }
      })
    );
  }
}
