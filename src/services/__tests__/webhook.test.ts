import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayEvent } from 'aws-lambda';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: jest.fn().mockImplementation(() => ({ send: mockSend })),
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  SendMessageCommand: jest.requireActual('@aws-sdk/client-sqs').SendMessageCommand
}));

import { handler } from '../../../webhook';

function makeEvent(emailAddress: string, historyId: string): APIGatewayEvent {
  const data = Buffer.from(JSON.stringify({ emailAddress, historyId })).toString('base64');
  return {
    body: JSON.stringify({ message: { data } })
  } as APIGatewayEvent;
}

describe('webhook ingress handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SQS_QUEUE_URL = 'https://sqs.ca-central-1.amazonaws.com/123/gmail-pubsub-queue';
    mockSend.mockResolvedValue({});
  });

  it('enqueues a valid PubSub notification to SQS and returns 200', async () => {
    const event = makeEvent('user@example.com', '12345');
    const result = await handler(event);

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledWith(expect.any(SendMessageCommand));
  });

  it('returns 400 for an invalid payload', async () => {
    const event = { body: 'not-json' } as APIGatewayEvent;
    const result = await handler(event);

    expect(result.statusCode).toBe(400);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns 500 when SQS_QUEUE_URL is not set', async () => {
    delete process.env.SQS_QUEUE_URL;
    const event = makeEvent('user@example.com', '12345');
    const result = await handler(event);

    expect(result.statusCode).toBe(500);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
