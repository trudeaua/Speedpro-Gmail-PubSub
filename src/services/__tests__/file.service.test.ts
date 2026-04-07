import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

import { FileService } from '@services/file.service';

jest.mock('@aws-sdk/client-s3');

const mockSend = jest.fn();
(S3Client as jest.Mock).mockImplementation(() => ({
  send: mockSend
}));

describe('FileService', () => {
  let fileService: FileService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.S3_STATE_BUCKET = 'gmailpubsub-state';
    fileService = new FileService();
  });

  describe('getObject', () => {
    it('returns the body string from S3', async () => {
      mockSend.mockResolvedValue({
        Body: { transformToString: jest.fn().mockResolvedValue('{"historyId":"123"}') }
      });

      const result = await fileService.getObject('state.json');

      expect(result).toBe('{"historyId":"123"}');
      expect(mockSend).toHaveBeenCalledWith(expect.any(GetObjectCommand));
    });

    it('throws when body is empty', async () => {
      mockSend.mockResolvedValue({
        Body: { transformToString: jest.fn().mockResolvedValue(undefined) }
      });

      await expect(fileService.getObject('state.json')).rejects.toThrow('Failed to parse object body');
    });

    it('throws when Body is undefined', async () => {
      mockSend.mockResolvedValue({ Body: undefined });

      await expect(fileService.getObject('state.json')).rejects.toThrow('Failed to parse object body');
    });
  });

  describe('putObject', () => {
    it('calls S3 with correct bucket, key, and body', async () => {
      const mockResponse = { ETag: '"abc"' };
      mockSend.mockResolvedValue(mockResponse);

      const result = await fileService.putObject('state.json', '{"historyId":"456"}');

      expect(result).toEqual(mockResponse);
      expect(mockSend).toHaveBeenCalledWith(expect.any(PutObjectCommand));
    });
  });
});
