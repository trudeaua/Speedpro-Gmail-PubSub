import type { gmail_v1 } from 'googleapis';
import { google } from 'googleapis';

import { GmailService } from '@services/gmail.service';

jest.mock('googleapis', () => ({
  google: {
    gmail: jest.fn()
  }
}));

const mockHistoryList = jest.fn();
const mockMessagesGet = jest.fn();
const mockUsersWatch = jest.fn();

(google.gmail as jest.Mock).mockReturnValue({
  users: {
    history: { list: mockHistoryList },
    messages: { get: mockMessagesGet },
    watch: mockUsersWatch
  }
});

describe('GmailService', () => {
  let gmailService: GmailService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GMAIL_LABEL_IDS = 'Label_5415779246622422776';
    (google.gmail as jest.Mock).mockReturnValue({
      users: {
        history: { list: mockHistoryList },
        messages: { get: mockMessagesGet },
        watch: mockUsersWatch
      }
    });
    gmailService = new GmailService({} as any);
  });

  describe('parseMessage', () => {
    it('extracts subject, from, and date from headers', () => {
      const message: gmail_v1.Schema$Message = {
        payload: {
          headers: [
            { name: 'Subject', value: 'Test Subject' },
            { name: 'From', value: 'sender@example.com' },
            { name: 'Date', value: 'Mon, 06 Apr 2026 12:00:00 GMT' }
          ]
        }
      };

      const result = GmailService.parseMessage(message);

      expect(result.subject).toBe('Test Subject');
      expect(result.from).toBe('sender@example.com');
      expect(result.date).toBe('Mon, 06 Apr 2026 12:00:00 GMT');
    });

    it('extracts and decodes HTML content from base64', () => {
      const htmlContent = '<p>Hello World</p>';
      const base64Content = Buffer.from(htmlContent).toString('base64');

      const message: gmail_v1.Schema$Message = {
        payload: {
          headers: [],
          parts: [{ mimeType: 'text/html', body: { data: base64Content } }]
        }
      };

      const result = GmailService.parseMessage(message);

      expect(result.content).toBe('<p>Hello World</p>');
    });

    it('returns undefined fields when headers and parts are absent', () => {
      const message: gmail_v1.Schema$Message = { payload: {} };

      const result = GmailService.parseMessage(message);

      expect(result.subject).toBeUndefined();
      expect(result.from).toBeUndefined();
      expect(result.date).toBeUndefined();
      expect(result.content).toBeUndefined();
    });
  });

  describe('getLabelIds', () => {
    it('returns the Corebridge alert label', () => {
      const labels = gmailService.getLabelIds();

      expect(labels).toEqual(['Label_5415779246622422776']);
    });
  });

  describe('listHistory', () => {
    it('calls gmail API with correct params', async () => {
      mockHistoryList.mockResolvedValue({ data: { history: [] } });

      await gmailService.listHistory('12345');

      expect(mockHistoryList).toHaveBeenCalledWith({
        userId: 'me',
        startHistoryId: '12345',
        maxResults: 500,
        historyTypes: ['messageAdded']
      });
    });
  });

  describe('getMessage', () => {
    it('returns response data', async () => {
      const mockMessage = { id: 'msg1', payload: {} };
      mockMessagesGet.mockResolvedValue({ data: mockMessage });

      const result = await gmailService.getMessage('msg1');

      expect(result).toEqual(mockMessage);
      expect(mockMessagesGet).toHaveBeenCalledWith({
        userId: 'me',
        id: 'msg1'
      });
    });
  });

  describe('watchUser', () => {
    it('calls watch with correct topic and labels', async () => {
      process.env.GCP_PUBSUB_TOPIC = 'projects/test/topics/gmail';
      mockUsersWatch.mockResolvedValue({ data: { historyId: '100', expiration: '999' } });

      const result = await gmailService.watchUser();

      expect(mockUsersWatch).toHaveBeenCalledWith({
        userId: 'me',
        requestBody: {
          labelIds: ['Label_5415779246622422776'],
          topicName: 'projects/test/topics/gmail',
          labelFilterBehavior: 'include'
        }
      });
      expect(result).toEqual({ historyId: '100', expiration: '999' });
    });
  });
});
