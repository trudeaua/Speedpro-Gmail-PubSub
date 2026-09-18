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
const mockGetProfile = jest.fn();

jest.mock('@services/gmail.service', () => ({
  GmailService: jest.fn().mockImplementation(() => ({
    getMessage: mockGetMessage,
    listHistory: mockListHistory,
    getLabelIds: mockGetLabelIds,
    getProfile: mockGetProfile
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

/**
 * Builds the S3 PreconditionFailed shape the SDK throws when IfMatch doesn't match.
 */
function preconditionFailed(): Error {
  const err = new Error('At least one of the pre-conditions you specified did not hold');
  err.name = 'PreconditionFailed';
  (err as Error & { $metadata: { httpStatusCode: number } }).$metadata = { httpStatusCode: 412 };
  return err;
}

describe('processor handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetObject.mockResolvedValue({ body: JSON.stringify({ historyId: '100' }), etag: '"v1"' });
    mockPutObject.mockResolvedValue({});
  });

  it('processes messages and updates state on success', async () => {
    mockListHistory.mockResolvedValue({
      data: {
        history: [
          {
            messagesAdded: [{ message: { id: 'msg-success-1', labelIds: ['INBOX'] } }]
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
    expect(mockPutObject).toHaveBeenCalledWith('state.json', JSON.stringify({ historyId: '200' }), {
      ifMatch: '"v1"'
    });
  });

  it('throws when a message fails to process (so SQS retries)', async () => {
    mockListHistory.mockResolvedValue({
      data: {
        history: [
          {
            messagesAdded: [{ message: { id: 'msg-fail-process-1', labelIds: ['INBOX'] } }]
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
            messagesAdded: [{ message: { id: 'msg-skip-label-1', labelIds: ['SPAM'] } }]
          }
        ]
      }
    });

    await handler(makeSQSEvent('user@example.com', '200'));

    expect(mockGetMessage).not.toHaveBeenCalled();
    expect(mockPutObject).toHaveBeenCalledWith('state.json', JSON.stringify({ historyId: '200' }), {
      ifMatch: '"v1"'
    });
  });

  it('does not update state when fetching a message fails', async () => {
    mockListHistory.mockResolvedValue({
      data: {
        history: [
          {
            messagesAdded: [{ message: { id: 'msg-fail-fetch-1', labelIds: ['INBOX'] } }]
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

  it('recovers from expired history (404) by resetting to current historyId', async () => {
    const error = new Error('Not Found') as Error & { code: number };
    error.code = 404;
    mockListHistory.mockRejectedValue(error);
    mockGetProfile.mockResolvedValue({ historyId: '500' });

    await handler(makeSQSEvent('user@example.com', '200'));

    expect(mockGetProfile).toHaveBeenCalledTimes(1);
    expect(mockPutObject).toHaveBeenCalledWith('state.json', JSON.stringify({ historyId: '500' }), {
      ifMatch: '"v1"'
    });
    expect(mockProcessMessage).not.toHaveBeenCalled();
  });

  it('rethrows non-404 errors from listHistory', async () => {
    mockListHistory.mockRejectedValue(new Error('Server error'));

    await expect(handler(makeSQSEvent('user@example.com', '200'))).rejects.toThrow('Server error');
    expect(mockGetProfile).not.toHaveBeenCalled();
    expect(mockPutObject).not.toHaveBeenCalled();
  });

  it('processes empty history without error and updates state', async () => {
    mockListHistory.mockResolvedValue({ data: { history: [] } });

    await handler(makeSQSEvent('user@example.com', '200'));

    expect(mockPutObject).toHaveBeenCalledWith('state.json', JSON.stringify({ historyId: '200' }), {
      ifMatch: '"v1"'
    });
  });

  describe('state commit', () => {
    beforeEach(() => {
      mockListHistory.mockResolvedValue({ data: { history: [] } });
    });

    it('re-reads and retries when another invocation wrote state first', async () => {
      mockGetObject
        .mockResolvedValueOnce({ body: JSON.stringify({ historyId: '100' }), etag: '"v1"' })
        .mockResolvedValueOnce({ body: JSON.stringify({ historyId: '150' }), etag: '"v2"' });
      mockPutObject.mockRejectedValueOnce(preconditionFailed()).mockResolvedValueOnce({});

      await handler(makeSQSEvent('user@example.com', '200'));

      expect(mockPutObject).toHaveBeenCalledTimes(2);
      expect(mockPutObject).toHaveBeenLastCalledWith('state.json', JSON.stringify({ historyId: '200' }), {
        ifMatch: '"v2"'
      });
    });

    it('gives up the write when the winner already moved state past us', async () => {
      mockGetObject
        .mockResolvedValueOnce({ body: JSON.stringify({ historyId: '100' }), etag: '"v1"' })
        .mockResolvedValueOnce({ body: JSON.stringify({ historyId: '900' }), etag: '"v2"' });
      mockPutObject.mockRejectedValueOnce(preconditionFailed());

      await handler(makeSQSEvent('user@example.com', '200'));

      // One rejected attempt, then nothing: 900 is already ahead of 200, so no rewind.
      expect(mockPutObject).toHaveBeenCalledTimes(1);
    });

    it('does not write at all when the stored historyId is already ahead', async () => {
      mockGetObject.mockResolvedValue({ body: JSON.stringify({ historyId: '300' }), etag: '"v1"' });

      await handler(makeSQSEvent('user@example.com', '200'));

      expect(mockPutObject).not.toHaveBeenCalled();
    });

    it('throws when the write keeps losing, so SQS retries', async () => {
      mockPutObject.mockRejectedValue(preconditionFailed());

      await expect(handler(makeSQSEvent('user@example.com', '200'))).rejects.toThrow('after 5 attempts');
      expect(mockPutObject).toHaveBeenCalledTimes(5);
    });

    it('rethrows non-precondition S3 errors', async () => {
      mockPutObject.mockRejectedValue(new Error('AccessDenied'));

      await expect(handler(makeSQSEvent('user@example.com', '200'))).rejects.toThrow('AccessDenied');
      expect(mockPutObject).toHaveBeenCalledTimes(1);
    });
  });
});
