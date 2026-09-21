import type { SendMessageCommandInput } from '@aws-sdk/client-sqs';
import { SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayEvent } from 'aws-lambda';

import { handler } from '../../../webhook';

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-sqs', () => ({
  // webhook.ts constructs its client at module load, and the import sort plugin puts that
  // import above `mockSend`. Delegate instead of capturing so send() resolves when called.
  SQSClient: jest.fn().mockImplementation(() => ({
    send: (...args: unknown[]): unknown => mockSend(...args)
  })),
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  SendMessageCommand: jest.requireActual('@aws-sdk/client-sqs').SendMessageCommand
}));

/**
 * Reads the input off the SendMessageCommand handed to the mocked client.
 */
function sentInput(call: number): SendMessageCommandInput {
  const calls = mockSend.mock.calls as unknown as [SendMessageCommand][];
  return calls[call][0].input;
}

function makeEvent(emailAddress: string, historyId: string | number): APIGatewayEvent {
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

  it('sends every notification in one FIFO group so the processor stays serial', async () => {
    await handler(makeEvent('user@example.com', '12345'));
    await handler(makeEvent('user@example.com', '67890'));

    expect([sentInput(0).MessageGroupId, sentInput(1).MessageGroupId]).toEqual(['gmail', 'gmail']);
  });

  it('dedupes on historyId so a repeated PubSub delivery is dropped by SQS', async () => {
    await handler(makeEvent('user@example.com', '12345'));

    expect(sentInput(0).MessageDeduplicationId).toBe('12345');
  });

  it('stringifies the numeric historyId Gmail actually sends', async () => {
    await handler(makeEvent('user@example.com', 12345));

    expect(sentInput(0).MessageDeduplicationId).toBe('12345');
    expect(JSON.parse(String(sentInput(0).MessageBody))).toEqual({
      emailAddress: 'user@example.com',
      historyId: '12345'
    });
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
