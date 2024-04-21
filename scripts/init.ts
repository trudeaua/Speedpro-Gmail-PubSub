import dotenv from "dotenv";
import { AuthService } from "@services/auth.service";
import { GmailService } from "@services/gmail.service";

dotenv.config();

/**
 * Authorize a user and watch their Gmail.
 *
 * After successful authorization, the user's Gmail will be watched for new messages.
 * The user's credentials will be stored in AWS Secrets Manager.
 */
async function main() {
  const authService = new AuthService();
  const auth = await authService.authorize(true);
  const gmail = new GmailService(auth);

  await gmail.watchUser();
}

main();
