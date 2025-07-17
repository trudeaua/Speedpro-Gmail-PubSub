# Speedpro Gmail PubSub

GCP PubSub Gmail Watcher built using Node.js on Serverless (AWS Lambda). Designed to parse specific email messages and create a series of folders in Google Drive based on email content.

# Setup

1. Ensure you have Node.js >= 18
2. You should have an AWS account for deployment as well
3. Download or clone this repository
4. Install dependencies by running `yarn`
5. Create a role for the deployed Lambdas that has permissions for S3 and Secrets Manager
6. Initialize authentication with google using the `scripts/init.ts` script

After successful authentication, a token for the Google auth result should have been created in Secrets Manager

7. Deploy Serverless framework

```
yarn sls deploy
```

After running this, 2 functions should have been created in AWS Lambda: `webhook` and `watcher`

8. Create a GCP PubSub topic following https://pcarion.com/posts/gmail-pubsub-aws-lambda/#enable-the-cloud-pubsub-api
   - Use the API gateway endpoint for `webhook` as the webhook endpoint for the PubSub subscription
