import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayEvent } from 'aws-lambda';
import dotenv from 'dotenv';

dotenv.config();

const sqs = new SQSClient({});

/**
 * Every notification goes into one FIFO message group so the processor runs one invocation
 * at a time. Splitting the group (per mailbox, say) would need state.json to be split the
 * same way first, since it tracks a single historyId.
 */
const MESSAGE_GROUP_ID = 'gmail';

/**
 * Parses the PubSub notification payload and extracts emailAddress and historyId.
 *
 * Gmail sends historyId as a JSON number, so it gets coerced here. Everything downstream
 * (the dedup id, the message body, the state file) treats it as a string.
 */
function parsePayload(event: APIGatewayEvent): { emailAddress: string; historyId: string } {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const payload = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const { emailAddress, historyId }: { emailAddress?: string; historyId?: string | number } = JSON.parse(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
    Buffer.from(payload.message.data, 'base64').toString('utf8')
  );

  if (!emailAddress || historyId === undefined || historyId === '') {
    throw new Error('Missing emailAddress or historyId in payload');
  }

  return { emailAddress, historyId: String(historyId) };
}

/**
 * Ingress Lambda handler. Validates the PubSub notification and enqueues it to SQS.
 */
export const handler = async (event: APIGatewayEvent): Promise<{ statusCode: number; body: string }> => {
  console.log('Received PubSub notification');

  let message: { emailAddress: string; historyId: string };
  try {
    message = parsePayload(event);
  } catch (err) {
    console.error('Invalid payload:', err);
    return { statusCode: 400, body: JSON.stringify('Invalid payload') };
  }

  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!queueUrl) {
    console.error('SQS_QUEUE_URL not configured');
    return { statusCode: 500, body: JSON.stringify('Server misconfiguration') };
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: MESSAGE_GROUP_ID,
      // Pub/Sub delivers at least once, so the same historyId can show up more than once.
      // SQS drops the repeat within its 5 minute dedup window.
      MessageDeduplicationId: message.historyId
    })
  );

  console.log(`Enqueued historyId=${message.historyId}`);
  return { statusCode: 200, body: JSON.stringify('Enqueued') };
};
