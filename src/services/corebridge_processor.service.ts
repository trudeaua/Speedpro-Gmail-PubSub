import dayjs from "dayjs";
import type { OAuth2Client } from "google-auth-library";
import { gmail_v1 } from "googleapis/build/src/apis/gmail/v1";
import { DriveService } from "./drive.service";
import { GmailService, ParsedMessage } from "./gmail.service";

export class CorebridgeProcessorService {
  private readonly driveService: DriveService;
  public constructor(auth: OAuth2Client) {
    this.driveService = new DriveService(auth);
  }

  /**
   * Checks if the given message is a new customer message.
   *
   * @param {ParsedMessage} message - The parsed email message.
   * @return {boolean} True if the message is a new customer message, false otherwise.
   */
  private static isNewCustomer(message: ParsedMessage): boolean {
    return message.subject === "New Customer";
  }

  /**
   * Checks if the given message is a new estimate message.
   *
   * @param {ParsedMessage} message - The parsed email message.
   * @return {boolean} True if the message is a new estimate message, false otherwise.
   */
  private static isNewEstimate(message: ParsedMessage): boolean {
    return message.subject === "New Estimate";
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
    const emailWhitelist = [
      "alert@corebridge.net",
      "jeff@speedproerinmills.ca",
      "alex@speedproerinmills.ca",
      "alextrudeau97@gmail.com",
    ];

    // Check if the message comes from a whitelisted email address.
    const isValidFrom = Boolean(
      message.from &&
        emailWhitelist.some((email) => (message.from ?? "").includes(email))
    );

    // Check if the message is a new customer message or a new estimate message.
    const isValidSubject =
      CorebridgeProcessorService.isNewCustomer(message) ||
      CorebridgeProcessorService.isNewEstimate(message);

    // Return true if the message is valid, false otherwise.
    return isValidFrom && isValidSubject;
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
    const { content = "", from = "", subject = "", date = "" } = parsedMessage;

    // Check if the message is valid.
    if (!CorebridgeProcessorService.isValidMessage(parsedMessage)) {
      // Log a warning and skip the message if it is invalid.
      console.warn(
        "Invalid email message: ",
        from,
        subject,
        date,
        Boolean(content),
        "Skipping."
      );
      return;
    }

    // Parse the headers of the message.
    const labels = [
      "Alert",
      "Customer",
      "Reference #",
      "Salesperson",
      "Description",
      "Event",
      "SubTotal Price",
      "Occurred",
    ];

    const headers: Record<string, string> = {};
    for (const label of labels) {
      const match = content.match(new RegExp(`${label}:\s*(.*?)\n`));
      if (match) {
        headers[label] = match[1].trim().replace(/<pre>|<\/pre>/g, "");
      }
    }

    // Append the date from the message metadata to the headers.
    headers["METADATA_DATE"] = date;

    // Process the message as a new customer if applicable.
    if (CorebridgeProcessorService.isNewCustomer(parsedMessage)) {
      await this.processNewCustomer(headers);
    }

    // Process the message as a new estimate if applicable.
    if (CorebridgeProcessorService.isNewEstimate(parsedMessage)) {
      await this.processNewEstimate(headers);
    }
  }

  /**
   * Process a new customer message and create a directory for their client files in Google Drive.
   *
   * @param {Record<string, string>} headers - The headers of the message.
   * @return {Promise<void>} A promise that resolves when the directory is created.
   */
  private async processNewCustomer(headers: Record<string, string>) {
    // Extract the customer name from the headers.
    const customer = headers.Customer;
    // Extract the first character of the customer name and convert it to uppercase.
    const beginsWith = customer.at(0)?.toUpperCase();

    // Log a warning and skip the message if the customer name is invalid.
    if (!customer || !beginsWith) {
      console.warn("Invalid customer name. Skipping.");
      return;
    }

    // Create a directory for the customer in Google Drive.
    // The directory will be nested in "Client Files/<beginsWith>/<customer>/"
    // The sub-folders "<beginsWith>" and "<customer>" will be created if they don't exist.
    // This function call is asynchronous and returns a promise that resolves when the directory is created.
    await this.driveService.createSubFolders([beginsWith, customer]);
  }

  /**
   * Process a new estimate message and create a directory and subdirectories for the estimate files in Google Drive.
   *
   * @param {Record<string, string>} headers - The headers of the message.
   * @return {Promise<void>} A promise that resolves when the directory and subdirectories are created.
   */
  private async processNewEstimate(headers: Record<string, string>) {
    // Extract the required headers
    const customer = headers.Customer;
    const occurred = headers.METADATA_DATE ?? headers.Occurred;
    const reference = headers["Reference #"]?.split("-")[1];
    const description = headers.Description;

    // Log a warning and skip the message if any of the required headers are invalid.
    if (!customer || !occurred || !reference || !description) {
      console.warn("Invalid estimate. Skipping.");
      return;
    }

    // Construct the directory name
    const date = occurred
      ? dayjs(occurred).add(dayjs(occurred).utcOffset(), "minutes")
      : undefined;
    const year = date?.get("year");
    const month = date
      ? (date.get("month") + 1).toString().padStart(2, "0")
      : undefined;
    const dirName = `${year}.${month}_${reference}_${description}`;

    // Construct the directory path
    const beginsWith = customer.at(0)?.toUpperCase();
    if (!customer || !beginsWith) {
      console.warn("Invalid customer name. Skipping.");
      return;
    }
    const directory = [beginsWith, customer, dirName];

    // Create the directory and subdirectories
    console.log(customer, dirName);
    await this.driveService.createSubFolders([...directory]);

    const subfolders: Record<string, string[]> = {
      "1_Artwork": ["Assets"],
      "2_Permits": [],
      "3_Photos": ["Survey", "Progress", "Completion"],
      "4_Production": [],
      "5_Quotes": [],
    };

    // Create the subdirectories
    for (const subfolder in subfolders) {
      const hasSubfolders = subfolders[subfolder].length > 0;
      if (hasSubfolders) {
        // If there are subfolders, create the folder and its subfolders
        for (const subsubfolder of subfolders[subfolder]) {
          await this.driveService.createSubFolders([
            ...directory,
            subfolder,
            subsubfolder,
          ]);
        }
      } else {
        // Otherwise just create the folder
        await this.driveService.createSubFolders([...directory, subfolder]);
      }
    }
  }
}
