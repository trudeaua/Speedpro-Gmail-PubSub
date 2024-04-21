import dotenv from 'dotenv';

import { AuthService } from '@services/auth.service';
import { GmailService } from '@services/gmail.service';

dotenv.config();

/**
 * AWS Lambda handler function to watch a user's Gmail.
 *
 * @param {APIGatewayEvent} _event - The event that triggered the function.
 * @param {Context} _context - The context of the function.
 * @returns {Promise<{ statusCode: number, body: string }>} - A promise that resolves to an object with a status code and a body.
 */
export const handler = async (): Promise<{ statusCode: number; body: string }> => {
  // Create an instance of the AuthService.
  const authService = new AuthService();

  // Authorize the user.
  const auth = await authService.authorize();

  // Create an instance of the GmailService.
  const gmailService = new GmailService(auth);

  // Watch the user.
  await gmailService.watchUser();

  // Return a successful response.
  return {
    statusCode: 200,
    body: JSON.stringify('Watching user!')
  };
};
