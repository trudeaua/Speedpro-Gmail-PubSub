import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import type { APIGatewayEvent } from 'aws-lambda';
import dotenv from 'dotenv';

dotenv.config();

const sqs = new SQSClient({});

/**
 * Parses the PubSub notification payload and extracts emailAddress and historyId.
 */
function parsePayload(event: APIGatewayEvent): { emailAddress: string; historyId: string } {
  const payload = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  const { emailAddress, historyId }: { emailAddress: string; historyId: string } = JSON.parse(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-member-access
    Buffer.from(payload.message.data, 'base64').toString('utf8')
  );

  if (!emailAddress || !historyId) {
    throw new Error('Missing emailAddress or historyId in payload');
  }

  return { emailAddress, historyId };
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
      MessageBody: JSON.stringify(message)
    })
  );

  console.log(`Enqueued historyId=${message.historyId}`);
  return { statusCode: 200, body: JSON.stringify('Enqueued') };
};
