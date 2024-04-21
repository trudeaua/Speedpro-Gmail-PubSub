import type { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis/build/src/apis/drive/v3';

/**
 * DriveService provides methods to interact with Google Drive API.
 */
export class DriveService {
  /**
   * Google Drive API client.
   */
  private readonly drive: drive_v3.Drive;
  /**
   * Drive ID to operate on.
   */
  private readonly DRIVE_ID: string;

  /**
   * Constructs a new DriveService instance.
   * @param auth - OAuth2 client.
   */
  public constructor(auth: OAuth2Client) {
    this.drive = google.drive({ version: 'v3', auth });
    this.DRIVE_ID = process.env.DRIVE_ID ?? '';
  }

  /**
   * Creates subfolders recursively.
   * @param folderNames - Names of folders to create.
   * @param currentFolderId - ID of the current folder to create subfolders in. Defaults to DRIVE_ID.
   * @returns Promise that resolves when all subfolders are created.
   */
  public async createSubFolders(folderNames: string[], currentFolderId = this.DRIVE_ID): Promise<void> {
    // Extract first folder name
    const folderName = folderNames.at(0);
    // Return if there is no folder name
    if (!folderName) {
      return;
    }
    // Prepare parents list
    const parents = [currentFolderId];
    // Get folder
    let folder = await this.getFolder(folderName, parents);
    // Create folder if it does not exist
    if (!folder) {
      folder = await this.createFolder(folderName, parents);
      // Throw error if folder creation fails
      if (!folder.id) {
        throw new Error(`Failed to create ${folderName}`);
      }
      console.log(`${folderName} created`);
    }
    // Call createSubFolders recursively on the rest of folder names
    const subFolderNames = folderNames.slice(1);
    await this.createSubFolders(subFolderNames, folder.id ?? currentFolderId);
  }

  /**
   * Get a folder by name and parents.
   * @param name - Name of the folder.
   * @param parents - List of parent folder IDs.
   * @returns Promise that resolves with the found folder, or undefined if not found.
   */
  private async getFolder(name: string, parents: string[]): Promise<drive_v3.Schema$File | undefined> {
    const query = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false and ${parents
      .map((parent) => `'${parent}' in parents`)
      .join(' and ')}`;
    const response = await this.drive.files.list({
      q: query,
      fields: 'nextPageToken, files(id, name, parents)',
      driveId: this.DRIVE_ID,
      includeItemsFromAllDrives: true,
      corpora: 'drive',
      supportsAllDrives: true
    });
    return response.data.files?.find((file) => file.name === name);
  }

  /**
   * Create a folder.
   * @param name - Name of the folder.
   * @param parents - List of parent folder IDs.
   * @returns Promise that resolves with the created folder.
   */
  private async createFolder(name: string, parents: string[]): Promise<drive_v3.Schema$File> {
    return new Promise<drive_v3.Schema$File>((resolve, reject) => {
      this.drive.files
        .create({
          requestBody: {
            name,
            mimeType: 'application/vnd.google-apps.folder',
            parents: parents
          },
          fields: 'id',
          supportsAllDrives: true
        })
        .then((res) => {
          resolve(res.data);
        })
        .catch((err) => {
          if (err instanceof Error) {
            reject(err);
            return;
          }
          console.error(err);
          return;
        });
    });
  }
}
