import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  DescribeSecretCommand,
  CreateSecretCommand
} from '@aws-sdk/client-secrets-manager';
import type { DescribeSecretCommandOutput, PutSecretValueCommandOutput } from '@aws-sdk/client-secrets-manager';
import { authenticate } from '@google-cloud/local-auth';
import fs from 'fs/promises';
import type { OAuth2Client } from 'google-auth-library';
import type { JWTInput } from 'google-auth-library/build/src/auth/credentials';
import { google } from 'googleapis';
import path from 'path';

export class AuthService {
  private readonly scopes: string[];
  private readonly credentialsPath: string;
  private readonly secretsManager: SecretsManagerClient;
  private readonly secretTokenId = 'gmailpubsub/google_token';

  public constructor() {
    this.scopes = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.readonly'];
    this.credentialsPath = path.join(process.cwd(), 'credentials.json');
    this.secretsManager = new SecretsManagerClient({});
  }

  /**
   * Authorizes the user and returns the OAuth2Client instance.
   * If the credentials are already present, they are loaded from the secrets manager.
   * If the credentials are not present in the secrets manager and the environment
   * is not production, the credentials are obtained by authenticating with the
   * Google Cloud API. The obtained credentials are then saved in the secrets manager.
   *
   * @return {Promise<OAuth2Client|null>} The OAuth2Client instance if the credentials
   * are found or obtained, null otherwise.
   * @throws {Error} If the environment is production and the credentials are not found.
   */
  public async authorize(startNewAuth = false): Promise<OAuth2Client> {
    // Load the saved credentials from the secrets manager if they exist
    let client: OAuth2Client | null = null;
    if (!startNewAuth) {
      client = await this.loadSavedCredentialsIfExist();
    }

    // If the credentials are not found, proceed to authenticate
    if (!client) {
      // In a production environment, credentials need to be present
      if (process.env.NODE_ENV === 'production') {
        throw new Error('Credentials not found');
      }

      // Authenticate with the Google Cloud API to obtain the credentials
      client = (await authenticate({
        scopes: this.scopes,
        keyfilePath: this.credentialsPath
      })) as unknown as OAuth2Client;

      // If the credentials exist, save them in the secrets manager
      await this.saveCredentials(client);
    }

    // Return the obtained or loaded credentials
    return client!;
  }

  /**
   * Retrieves the token from the secrets manager.
   *
   * @return {Promise<JWTInput>} The parsed JWTInput object from the secrets manager.
   * @throws {Error} If the secret string is missing or the token format is invalid.
   */
  private async getToken(): Promise<JWTInput> {
    // Create the command to get the secret value
    const command = new GetSecretValueCommand({
      // eslint-disable-next-line @typescript-eslint/naming-convention
      SecretId: this.secretTokenId
    });

    // Send the command to the secrets manager
    const response = await this.secretsManager.send(command);

    try {
      // Check if the secret string is missing
      if (response.SecretString == null) {
        throw new Error('Missing secret string');
      }

      // Parse the secret string
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const parsed = JSON.parse(response.SecretString);

      // Check if the token format is valid
      const reqProps = ['type', 'client_id', 'client_secret', 'refresh_token'];
      if (!reqProps.every((prop) => prop in parsed)) {
        throw new Error('Invalid token format');
      }

      // Return the parsed token
      return parsed as JWTInput;
    } catch (err) {
      // Log and re-throw the error
      console.error(err);
      throw new Error('Failed to parse token secret');
    }
  }

  /**
   * Puts a token into the secrets manager.
   * If the token doesn't exist, it creates it.
   *
   * @param {JWTInput} token - The token to be stored.
   * @return {Promise<DescribeSecretCommandOutput | PutSecretValueCommandOutput>} - A promise that resolves to the response of the describe or put secret command.
   * @throws {Error} - If there's an error other than ResourceNotFoundException, it's thrown.
   */
  private async putToken(token: JWTInput): Promise<DescribeSecretCommandOutput | PutSecretValueCommandOutput> {
    // Describe the secret to check if it exists
    const command = new DescribeSecretCommand({
      // eslint-disable-next-line @typescript-eslint/naming-convention
      SecretId: this.secretTokenId
    });
    let response: DescribeSecretCommandOutput | PutSecretValueCommandOutput;
    try {
      // Try to describe the secret
      response = await this.secretsManager.send(command);
    } catch (err) {
      // If the secret doesn't exist, create it
      if (err instanceof Error && err.name === 'ResourceNotFoundException') {
        const createCommand = new CreateSecretCommand({
          Name: this.secretTokenId,
          SecretString: JSON.stringify(token)
        });
        response = await this.secretsManager.send(createCommand);
      } else {
        // Throw any other error
        throw err;
      }
    }
    // If the secret exists, update it
    if (response.ARN) {
      const updateCommand = new PutSecretValueCommand({
        SecretId: this.secretTokenId,
        SecretString: JSON.stringify(token)
      });
      return this.secretsManager.send(updateCommand);
    } else {
      // Return the response of the describe command
      return response;
    }
  }

  /**
   * Load previously authorized credentials from the secrets manager if exists.
   *
   * @return {Promise<OAuth2Client|null>} An OAuth2Client object if the credentials exist, otherwise null.
   */
  private async loadSavedCredentialsIfExist(): Promise<OAuth2Client | null> {
    // Try to get the token
    try {
      // Get the token from the secrets manager
      const credentials = await this.getToken();
      // Deserialize the token to an OAuth2Client object
      return google.auth.fromJSON(credentials) as OAuth2Client;
    } catch (err) {
      // If the token doesn't exist, return null
      return null;
    }
  }

  /**
   * Serializes credentials to secrets manager
   *
   * @param {OAuth2Client} client
   * @return {Promise<void>}
   */
  private async saveCredentials(client: OAuth2Client): Promise<void> {
    const content = await fs.readFile(this.credentialsPath);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const keys = JSON.parse(content.toString());
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const key = keys.installed || keys.web;
    const token: JWTInput = {
      type: 'authorized_user',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      client_id: key.client_id,
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      client_secret: key.client_secret,
      refresh_token: client.credentials.refresh_token ?? undefined
    };
    await this.putToken(token);
  }
}
