import type { drive_v3 } from 'googleapis';
import { google } from 'googleapis';

import { DriveService } from '@services/drive.service';

jest.mock('googleapis', () => ({
  google: {
    drive: jest.fn()
  }
}));

const mockFilesList = jest.fn();
const mockFilesCreate = jest.fn();

function setupMocks() {
  (google.drive as jest.Mock).mockReturnValue({
    files: {
      list: mockFilesList,
      create: mockFilesCreate
    }
  });
}

describe('DriveService', () => {
  let driveService: DriveService;
  let folderCache: Map<string, drive_v3.Schema$File>;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DRIVE_ID = 'test-drive-id';
    folderCache = new Map();
    setupMocks();
    driveService = new DriveService({} as any, folderCache);
  });

  describe('createFolders', () => {
    it('does nothing for empty folder names array', async () => {
      await driveService.createFolders([]);

      expect(mockFilesList).not.toHaveBeenCalled();
      expect(mockFilesCreate).not.toHaveBeenCalled();
    });

    it('creates nested folders recursively', async () => {
      mockFilesList.mockResolvedValue({ data: { files: [] } });
      mockFilesCreate
        .mockResolvedValueOnce({ data: { id: 'folder-a-id' } })
        .mockResolvedValueOnce({ data: { id: 'folder-b-id' } });

      await driveService.createFolders(['FolderA', 'FolderB']);

      expect(mockFilesCreate).toHaveBeenCalledTimes(2);
    });

    it('throws when folder creation returns no id', async () => {
      mockFilesList.mockResolvedValue({ data: { files: [] } });
      mockFilesCreate.mockResolvedValue({ data: {} });

      await expect(driveService.createFolders(['NoIdFolder'])).rejects.toThrow('Failed to create NoIdFolder');
    });
  });

  describe('checkAndCreateFolder (via createFolders)', () => {
    it('returns cached folder without API call', async () => {
      folderCache.set('test-drive-id-CachedFolder', { id: 'cached-id', name: 'CachedFolder' });

      mockFilesList.mockResolvedValue({ data: { files: [] } });
      mockFilesCreate.mockResolvedValue({ data: { id: 'next-id' } });

      await driveService.createFolders(['CachedFolder', 'SubFolder']);

      expect(mockFilesList).toHaveBeenCalledTimes(1);
    });

    it('returns existing folder from API and caches it', async () => {
      const existingFolder = { id: 'existing-id', name: 'ExistingFolder' };
      mockFilesList.mockResolvedValue({ data: { files: [existingFolder] } });

      await driveService.createFolders(['ExistingFolder']);

      expect(mockFilesCreate).not.toHaveBeenCalled();
      expect(folderCache.get('test-drive-id-ExistingFolder')).toEqual(existingFolder);
    });

    it('creates a new folder when not found and caches it', async () => {
      const createdFolder = { id: 'new-id' };
      mockFilesList.mockResolvedValue({ data: { files: [] } });
      mockFilesCreate.mockResolvedValue({ data: createdFolder });

      await driveService.createFolders(['NewFolder']);

      expect(mockFilesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            name: 'NewFolder',
            mimeType: 'application/vnd.google-apps.folder',
            parents: ['test-drive-id']
          }),
          supportsAllDrives: true
        })
      );
      expect(folderCache.get('test-drive-id-NewFolder')).toEqual(createdFolder);
    });

    it('sanitizes special characters from folder names', async () => {
      mockFilesList.mockResolvedValue({ data: { files: [] } });
      mockFilesCreate.mockResolvedValue({ data: { id: 'sanitized-id' } });

      await driveService.createFolders(['Folder@#$Name']);

      expect(mockFilesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            name: 'FolderName'
          })
        })
      );
    });
  });
});
