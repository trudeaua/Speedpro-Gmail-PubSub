import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { StreamingBlobPayloadInputTypes } from '@smithy/types';

export class FileService {
  private readonly s3: S3Client;

  private readonly bucket = 'gmailpubsub-state';

  public constructor() {
    this.s3 = new S3Client({});
  }

  public async getObject(Key: string) {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key,
    });
    const response = await this.s3.send(command);
    const bodyString = await response.Body?.transformToString();
    if (!bodyString) {
      throw new Error('Failed to parse object body');
    }
    return bodyString;
  }

  public async putObject(Key: string, body: StreamingBlobPayloadInputTypes) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key,
      Body: body,
    });
    const response = await this.s3.send(command);
    return response;
  }
}
