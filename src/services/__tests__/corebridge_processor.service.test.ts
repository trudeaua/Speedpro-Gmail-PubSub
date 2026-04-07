import { google } from 'googleapis';

import { CorebridgeProcessorService } from '@services/corebridge_processor.service';

jest.mock('googleapis', () => ({
  google: {
    drive: jest.fn().mockReturnValue({
      files: {
        list: jest.fn().mockResolvedValue({ data: { files: [] } }),
        create: jest.fn().mockResolvedValue({ data: { id: 'mock-id' } })
      }
    })
  }
}));

function buildGmailMessage(from: string, subject: string, date: string, htmlBody: string) {
  return {
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'Subject', value: subject },
        { name: 'Date', value: date }
      ],
      parts: [
        {
          mimeType: 'text/html',
          body: { data: Buffer.from(htmlBody).toString('base64') }
        }
      ]
    }
  };
}

describe('CorebridgeProcessorService', () => {
  let service: CorebridgeProcessorService;
  let mockCreateFolders: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DRIVE_ID = 'test-drive-id';
    process.env.ALERT_EMAIL_WHITELIST = 'alert@corebridge.net';
    service = new CorebridgeProcessorService({} as any, new Map());
    mockCreateFolders = jest.spyOn((service as any).driveService, 'createFolders').mockResolvedValue(undefined);
  });

  describe('processMessage', () => {
    it('skips messages from non-whitelisted senders', async () => {
      const message = buildGmailMessage('spam@other.com', 'Test', '2026-04-06', 'body');
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      await service.processMessage(message);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid email message'),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
      expect(mockCreateFolders).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('routes New Customer alert to folder creation', async () => {
      const body = 'Alert: New Customer\nCustomer: Acme Corp\nEnd';
      const message = buildGmailMessage('alert@corebridge.net', 'New Customer', '2026-04-06', body);

      await service.processMessage(message);

      expect(mockCreateFolders).toHaveBeenCalledWith(['A', 'Acme Corp']);
    });

    it('routes New Estimate alert to estimate folder creation', async () => {
      const body = 'Alert: New Estimate\nCustomer: Acme Corp\nReference #: EST-12345\nDescription: Sign Project\nOccurred: 2026-04-06\n';
      const message = buildGmailMessage('alert@corebridge.net', 'New Estimate', '2026-04-06T12:00:00Z', body);

      await service.processMessage(message);

      expect(mockCreateFolders).toHaveBeenCalled();
      expect(mockCreateFolders.mock.calls[0][0]).toEqual(
        expect.arrayContaining(['A', 'Acme Corp'])
      );
    });

    it('routes New Order alert to estimate folder creation', async () => {
      const body = 'Alert: New Order\nCustomer: Acme Corp\nReference #: ORD-99999\nDescription: Banner\nOccurred: 2026-04-06\n';
      const message = buildGmailMessage('alert@corebridge.net', 'New Order', '2026-04-06T12:00:00Z', body);

      await service.processMessage(message);

      expect(mockCreateFolders).toHaveBeenCalled();
    });

    it('skips unknown alert types', async () => {
      const body = 'Alert: Unknown Type\nCustomer: Acme Corp\n';
      const message = buildGmailMessage('alert@corebridge.net', 'Unknown', '2026-04-06', body);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      await service.processMessage(message);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid alert'));
      expect(mockCreateFolders).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('processNewCustomer', () => {
    it('skips when customer name is missing', async () => {
      const body = 'Alert: New Customer\n';
      const message = buildGmailMessage('alert@corebridge.net', 'New Customer', '2026-04-06', body);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      await service.processMessage(message);

      expect(mockCreateFolders).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('processNewEstimate', () => {
    it('skips when required headers are missing', async () => {
      const body = 'Alert: New Estimate\nCustomer: Acme Corp\n';
      const message = buildGmailMessage('alert@corebridge.net', 'New Estimate', '2026-04-06', body);
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      await service.processMessage(message);

      expect(warnSpy).toHaveBeenCalledWith('Invalid estimate. Skipping.');
      expect(mockCreateFolders).not.toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('creates correct directory structure for estimate', async () => {
      const body = 'Alert: New Estimate\nCustomer: Acme Corp\nReference #: EST-12345\nDescription: Sign Project\nOccurred: 2026-04-06\n';
      const message = buildGmailMessage('alert@corebridge.net', 'New Estimate', '2026-04-06T12:00:00Z', body);

      await service.processMessage(message);

      const rootCall = mockCreateFolders.mock.calls[0][0];
      expect(rootCall[0]).toBe('A');
      expect(rootCall[1]).toBe('Acme Corp');
      expect(rootCall[2]).toMatch(/^\d{4}\.\d{2}_12345_Sign Project$/);

      const secondLayerCalls = mockCreateFolders.mock.calls.slice(1, 6);
      const secondLayerNames = secondLayerCalls.map((call: string[][]) => call[0][3]);
      expect(secondLayerNames).toEqual(
        expect.arrayContaining(['1_Artwork', '2_Permits', '3_Photos', '4_Production', '5_Quotes'])
      );

      const thirdLayerCalls = mockCreateFolders.mock.calls.slice(6);
      const thirdLayerNames = thirdLayerCalls.map((call: string[][]) => call[0][4]);
      expect(thirdLayerNames).toEqual(
        expect.arrayContaining(['Assets', 'Survey', 'Progress', 'Completion'])
      );
    });
  });
});
