import type { PutObjectCommandOutput } from '@aws-sdk/client-s3';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import type { StreamingBlobPayloadInputTypes } from '@smithy/types';

/**
 * An object's contents plus the ETag needed to write it back conditionally.
 */
export interface GetObjectResult {
  /**
   * The contents of the object.
   */
  body: string;

  /**
   * The object's current ETag, for use as `ifMatch` on a subsequent put.
   */
  etag?: string;
}

/**
 * Options for a put.
 */
export interface PutObjectOptions {
  /**
   * Only write if the object's current ETag matches. S3 rejects the write with
   * PreconditionFailed otherwise, which is how concurrent writers are detected.
   */
  ifMatch?: string;
}

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
  private readonly bucket = process.env.S3_STATE_BUCKET ?? '';

  /**
   * Creates a new FileService instance.
   */
  public constructor() {
    this.s3 = new S3Client({});
  }

  /**
   * Retrieves the contents of an object from the S3 bucket, along with its ETag.
   *
   * @param Key - The key of the object to retrieve.
   * @returns The contents of the object and its ETag.
   * @throws Error if the object body cannot be parsed.
   */
  public async getObject(Key: string): Promise<GetObjectResult> {
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
    return { body: bodyString, etag: response.ETag };
  }

  /**
   * Puts an object into the S3 bucket.
   *
   * @param Key - The key of the object to put.
   * @param body - The contents of the object to put.
   * @param options - Optional preconditions for the write.
   * @returns The response from the S3 put command.
   * @throws PreconditionFailed if `ifMatch` is given and the stored ETag has moved on.
   */
  public async putObject(
    Key: string,
    body: StreamingBlobPayloadInputTypes,
    options: PutObjectOptions = {}
  ): Promise<PutObjectCommandOutput> {
    // Create a command to put the object into S3
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key,
      Body: body,
      IfMatch: options.ifMatch
    });
    // Send the command and get the response
    const response = await this.s3.send(command);
    return response;
  }
}
