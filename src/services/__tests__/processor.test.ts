import type { SQSEvent, SQSRecord } from 'aws-lambda';

import { handler } from '../../../processor';

jest.mock('@services/auth.service', () => ({
  AuthService: jest.fn().mockImplementation(() => ({
    authorize: jest.fn().mockResolvedValue({})
  }))
}));

const mockGetMessage = jest.fn();
const mockListHistory = jest.fn();
const mockGetLabelIds = jest.fn().mockReturnValue(['INBOX']);

jest.mock('@services/gmail.service', () => ({
  GmailService: jest.fn().mockImplementation(() => ({
    getMessage: mockGetMessage,
    listHistory: mockListHistory,
    getLabelIds: mockGetLabelIds
  }))
}));

const mockProcessMessage = jest.fn();
jest.mock('@services/corebridge_processor.service', () => ({
  CorebridgeProcessorService: jest.fn().mockImplementation(() => ({
    processMessage: mockProcessMessage
  }))
}));

const mockGetObject = jest.fn();
const mockPutObject = jest.fn();
jest.mock('@services/file.service', () => ({
  FileService: jest.fn().mockImplementation(() => ({
    getObject: mockGetObject,
    putObject: mockPutObject
  }))
}));

function makeSQSEvent(emailAddress: string, historyId: string): SQSEvent {
  return {
    Records: [
      {
        body: JSON.stringify({ emailAddress, historyId })
      } as SQSRecord
    ]
  };
}

describe('processor handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetObject.mockResolvedValue(JSON.stringify({ historyId: '100' }));
    mockPutObject.mockResolvedValue({});
  });

  it('processes messages and updates state on success', async () => {
    mockListHistory.mockResolvedValue({
      data: {
        history: [
          {
            messagesAdded: [
              { message: { id: 'msg-success-1', labelIds: ['INBOX'] } }
            ]
          }
        ]
      }
    });
    mockGetMessage.mockResolvedValue({ id: 'msg-success-1', payload: {} });
    mockProcessMessage.mockResolvedValue(undefined);

    await handler(makeSQSEvent('user@example.com', '200'));

    expect(mockGetMessage).toHaveBeenCalledWith('msg-success-1');
    expect(mockProcessMessage).toHaveBeenCalledTimes(1);
    // State should be updated to max(200, 100) = 200
    expect(mockPutObject).toHaveBeenCalledWith('state.json', JSON.stringify({ historyId: '200' }));
  });

  it('throws when a message fails to process (so SQS retries)', async () => {
    mockListHistory.mockResolvedValue({
      data: {
        history: [
          {
            messagesAdded: [
              { message: { id: 'msg-fail-process-1', labelIds: ['INBOX'] } }
            ]
          }
        ]
      }
    });
    mockGetMessage.mockResolvedValue({ id: 'msg-fail-process-1', payload: {} });
    mockProcessMessage.mockRejectedValue(new Error('Drive API error'));

    await expect(handler(makeSQSEvent('user@example.com', '200'))).rejects.toThrow(
      'One or more messages failed to process'
    );
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it('skips messages without a valid label', async () => {
    mockListHistory.mockResolvedValue({
      data: {
        history: [
          {
            messagesAdded: [
              { message: { id: 'msg-skip-label-1', labelIds: ['SPAM'] } }
            ]
          }
        ]
      }
    });

    await handler(makeSQSEvent('user@example.com', '200'));

    expect(mockGetMessage).not.toHaveBeenCalled();
    expect(mockPutObject).toHaveBeenCalledWith('state.json', JSON.stringify({ historyId: '200' }));
  });

  it('does not update state when fetching a message fails', async () => {
    mockListHistory.mockResolvedValue({
      data: {
        history: [
          {
            messagesAdded: [
              { message: { id: 'msg-fail-fetch-1', labelIds: ['INBOX'] } }
            ]
          }
        ]
      }
    });
    mockGetMessage.mockRejectedValue(new Error('Gmail API error'));

    await expect(handler(makeSQSEvent('user@example.com', '200'))).rejects.toThrow(
      'One or more messages failed to process'
    );
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it('processes empty history without error and updates state', async () => {
    mockListHistory.mockResolvedValue({ data: { history: [] } });

    await handler(makeSQSEvent('user@example.com', '200'));

    expect(mockPutObject).toHaveBeenCalledWith('state.json', JSON.stringify({ historyId: '200' }));
  });
});
