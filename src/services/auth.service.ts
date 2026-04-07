import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { JWT } from 'google-auth-library';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export class AuthService {
  private readonly scopes: string[];
  private readonly secretsManager: SecretsManagerClient;
  private readonly secretId = process.env.SECRET_TOKEN_ID ?? '';
  private readonly subject = process.env.GOOGLE_IMPERSONATE_EMAIL ?? '';

  public constructor() {
    this.scopes = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.readonly'];
    this.secretsManager = new SecretsManagerClient({});
  }

  public async authorize(): Promise<JWT> {
    const key = await this.getServiceAccountKey();
    return new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: this.scopes,
      subject: this.subject
    });
  }

  private async getServiceAccountKey(): Promise<ServiceAccountKey> {
    const command = new GetSecretValueCommand({ SecretId: this.secretId });
    const response = await this.secretsManager.send(command);

    if (!response.SecretString) {
      throw new Error('Missing secret string');
    }

    const parsed: unknown = JSON.parse(response.SecretString);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('client_email' in parsed) ||
      !('private_key' in parsed)
    ) {
      throw new Error('Invalid service account key format');
    }

    return parsed as ServiceAccountKey;
  }
}
