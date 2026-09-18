import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { JWT } from 'google-auth-library';

import { AuthService } from '@services/auth.service';

jest.mock('@aws-sdk/client-secrets-manager');
jest.mock('google-auth-library');

const mockSend = jest.fn();
(SecretsManagerClient as jest.Mock).mockImplementation(() => ({
  send: mockSend
}));

const validKey = {
  client_email: 'test@project.iam.gserviceaccount.com',
  private_key: '-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n'
};

describe('AuthService', () => {
  let authService: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SECRET_TOKEN_ID = 'gmailpubsub/google_token';
    process.env.GOOGLE_IMPERSONATE_EMAIL = 'user@example.com';
    authService = new AuthService();
  });

  describe('authorize', () => {
    it('returns a JWT configured with service account credentials', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validKey) });

      await authService.authorize();

      expect(JWT).toHaveBeenCalledWith({
        email: validKey.client_email,
        key: validKey.private_key,
        scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/gmail.readonly'],
        subject: 'user@example.com'
      });
    });

    it('passes the correct secret ID to SecretsManager', async () => {
      mockSend.mockResolvedValue({ SecretString: JSON.stringify(validKey) });

      await authService.authorize();

      expect(mockSend).toHaveBeenCalledWith(expect.any(GetSecretValueCommand));
    });

    it('throws when SecretString is missing', async () => {
      mockSend.mockResolvedValue({ SecretString: undefined });

      await expect(authService.authorize()).rejects.toThrow('Missing secret string');
    });

    it('throws when key is missing client_email', async () => {
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({ private_key: 'key' })
      });

      await expect(authService.authorize()).rejects.toThrow('Invalid service account key format');
    });

    it('throws when key is missing private_key', async () => {
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({ client_email: 'email' })
      });

      await expect(authService.authorize()).rejects.toThrow('Invalid service account key format');
    });

    it('throws when SecretString is not valid JSON', async () => {
      mockSend.mockResolvedValue({ SecretString: 'not-json' });

      await expect(authService.authorize()).rejects.toThrow();
    });
  });
});
