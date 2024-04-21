import type { PutObjectCommandOutput } from '@aws-sdk/client-s3';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { StreamingBlobPayloadInputTypes } from '@smithy/types';

/**
 * Service for handling file operations in AWS S3.
 */
export class FileService {
  /**
   * AWS S3 client.
   */
  private readonly s3: S3Client;

  /**
   * Name of the S3 bucket used for storing files.
   */
  private readonly bucket = 'gmailpubsub-state';

  /**
   * Creates a new FileService instance.
   */
  public constructor() {
    this.s3 = new S3Client({});
  }

  /**
   * Retrieves the contents of an object from the S3 bucket.
   *
   * @param Key - The key of the object to retrieve.
   * @returns The contents of the object as a string.
   * @throws Error if the object body cannot be parsed.
   */
  public async getObject(Key: string): Promise<string> {
    // Create a command to get the object from S3
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key
    });
    // Send the command and get the response
    const response = await this.s3.send(command);
    // Get the string contents of the object
    const bodyString = await response.Body?.transformToString();
    // If the object body cannot be parsed, throw an error
    if (!bodyString) {
      throw new Error('Failed to parse object body');
    }
    return bodyString;
  }

  /**
   * Puts an object into the S3 bucket.
   *
   * @param Key - The key of the object to put.
   * @param body - The contents of the object to put.
   * @returns The response from the S3 put command.
   */
  public async putObject(Key: string, body: StreamingBlobPayloadInputTypes): Promise<PutObjectCommandOutput> {
    // Create a command to put the object into S3
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key,
      Body: body
    });
    // Send the command and get the response
    const response = await this.s3.send(command);
    return response;
  }
}
