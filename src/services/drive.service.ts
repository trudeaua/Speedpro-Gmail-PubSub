import type { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis/build/src/apis/drive/v3';
import util from 'util';

/**
 * DriveService provides methods to interact with Google Drive API.
 */
export class DriveService {
  private readonly drive: drive_v3.Drive;
  private readonly DRIVE_ID: string;
  private readonly folderCache: Map<string, drive_v3.Schema$File>;

  public constructor(auth: OAuth2Client, folderCache: Map<string, drive_v3.Schema$File>) {
    this.drive = google.drive({ version: 'v3', auth });
    this.DRIVE_ID = process.env.DRIVE_ID ?? '';
    this.folderCache = folderCache;
  }

  private static debugLog(message: string, ...params: unknown[]): void {
    const debug = util.debuglog('DRIVE_SERVICE');
    debug(message, params);
  }

  private static sanitizeFolderName(folderName: string): string {
    return folderName.replace(/[^a-zA-Z0-9\s._-]/g, '');
  }

  public async createFolders(folderNames: string[], parentFolderId: string = this.DRIVE_ID): Promise<void> {
    const folderName = folderNames.at(0);
    if (!folderName) {
      return;
    }
    DriveService.debugLog(`Creating folders ${folderNames.toString()}`);

    const folder = await this.checkAndCreateFolder(parentFolderId, folderName);
    if (!folder.id) {
      throw new Error(`Failed to create ${folderName}`);
    }

    const subFolderNames = folderNames.slice(1);
    await this.createFolders(subFolderNames, folder.id);
  }

  private async checkAndCreateFolder(parentFolderId: string, folderName: string): Promise<drive_v3.Schema$File> {
    const cleanFolderName = DriveService.sanitizeFolderName(folderName);
    const cacheKey = `${parentFolderId}-${cleanFolderName}`;
    DriveService.debugLog(`Checking cache for ${cacheKey}`);
    // Check the cache for the folder
    if (this.folderCache.has(cacheKey)) {
      DriveService.debugLog(`${cleanFolderName} exists in cache. Retrieved.`);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      return this.folderCache.get(cacheKey)!;
    } else {
      DriveService.debugLog(`${cleanFolderName} not in cache. Checking drive...`);
    }

    // If not in cache, check the drive
    const query = `mimeType = 'application/vnd.google-apps.folder' and name = '${cleanFolderName}' and '${parentFolderId}' in parents and trashed = false`;
    const response = await this.drive.files.list({
      q: query,
      fields: 'nextPageToken, files(id, name, parents)',
      driveId: this.DRIVE_ID,
      includeItemsFromAllDrives: true,
      corpora: 'drive',
      supportsAllDrives: true
    });
    const existingFolders = response.data.files;
    if (existingFolders?.length) {
      const [folder] = existingFolders;
      DriveService.debugLog(`${cleanFolderName} exists. Retrieved.`);
      // Update cache
      this.folderCache.set(cacheKey, folder);
      return folder;
    }
    DriveService.debugLog(`${cleanFolderName} does not exist in drive. Creating...`);
    // Else create the folder
    const folderMetadata: drive_v3.Schema$File = {
      name: cleanFolderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentFolderId]
    };
    const folder = await this.drive.files.create({
      requestBody: folderMetadata,
      fields: 'id',
      supportsAllDrives: true
    });
    DriveService.debugLog(`${cleanFolderName} created.`);
    // Update cache
    this.folderCache.set(cacheKey, folder.data);
    return folder.data;
  }
}
