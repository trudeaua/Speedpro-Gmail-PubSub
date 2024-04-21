import { OAuth2Client } from 'google-auth-library';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis/build/src/apis/drive/v3';

export class DriveService {
  private readonly drive: drive_v3.Drive;
  private readonly DRIVE_ID: string;

  public constructor(auth: OAuth2Client) {
    this.drive = google.drive({ version: 'v3', auth });
    this.DRIVE_ID = process.env.DRIVE_ID ?? '';
  }

  public async createSubFolders(folderNames: string[], currentFolderId = this.DRIVE_ID): Promise<void> {
    const folderName = folderNames.at(0);
    if (!folderName) {
      return;
    }
    const parents = [currentFolderId];
    let folder = await this.getFolder(folderName, parents);

    if (!folder) {
      folder = await this.createFolder(folderName, parents);

      if (!folder?.id) {
        throw new Error(`Failed to create ${folderName}`);
      }

      console.log(`${folderName} created`);
    }

    const subFolderNames = folderNames.slice(1); // Exclude the current folder name
    await this.createSubFolders(subFolderNames, folder?.id ?? currentFolderId);
  }

  private async getFolder(name: string, parents: string[]) {
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

  private async createFolder(name: string, parents: string[]) {
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
          reject(err);
        });
    });
  }
}
