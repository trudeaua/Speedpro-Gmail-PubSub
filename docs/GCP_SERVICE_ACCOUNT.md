# GCP Service Account Setup

This project uses a Google Cloud service account with domain-wide delegation to access Gmail and Drive APIs on behalf of a Workspace user. This avoids OAuth2 refresh tokens which can expire or be revoked.

## Scopes

The service account requires the following scopes across projects:

### Speedpro-Gmail-PubSub (this project)
- `https://www.googleapis.com/auth/gmail.readonly`
- `https://www.googleapis.com/auth/drive`

### Other projects sharing this service account
- `https://www.googleapis.com/auth/gmail.send`
- `https://www.googleapis.com/auth/drive.file`
- `https://www.googleapis.com/auth/drive.metadata.readonly`

When configuring domain-wide delegation, include **all** scopes the service account will need across projects.

## Setup Steps

### 1. Create the service account

1. Go to [GCP Console → IAM & Admin → Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Click **Create Service Account**
3. Name it (e.g. `speedpro-automation`)
4. No roles needed — API access is granted via domain-wide delegation, not IAM roles
5. Click **Done**

### 2. Enable domain-wide delegation

1. Click the newly created service account
2. Go to **Advanced settings** (or **Show domain-wide delegation**)
3. Check **Enable Google Workspace Domain-wide Delegation**
4. Save — note the **Client ID** (numeric)

### 3. Authorize scopes in Google Workspace Admin

1. Go to [Google Workspace Admin → Security → API Controls → Domain-wide Delegation](https://admin.google.com/ac/owl/domainwidedelegation)
2. Click **Add new**
3. Enter the service account **Client ID**
4. Add the following scopes (comma-separated):
   ```
   https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/gmail.send,https://www.googleapis.com/auth/drive,https://www.googleapis.com/auth/drive.file,https://www.googleapis.com/auth/drive.metadata.readonly
   ```
5. Click **Authorize**

### 4. Create and download the key

1. Go back to the service account in GCP Console
2. Go to **Keys** → **Add Key** → **Create new key**
3. Select **JSON** and download the file

### 5. Store the key in AWS Secrets Manager

Store the entire JSON key file contents as the secret value:

```bash
aws secretsmanager put-secret-value \
  --secret-id gmailpubsub/google_token \
  --secret-string file://path/to/service-account-key.json
```

If the secret doesn't exist yet:

```bash
aws secretsmanager create-secret \
  --name gmailpubsub/google_token \
  --secret-string file://path/to/service-account-key.json
```

### 6. Delete the local key file

The key is now in Secrets Manager. Delete the local copy:

```bash
rm path/to/service-account-key.json
```

## Impersonated User

The mailbox the service account acts as comes from the `GOOGLE_IMPERSONATE_EMAIL` environment
variable. `AuthService` passes it to the JWT client as the `subject`.

Set it in `.env` for local runs, and as a repository variable in GitHub for deployed runs (the
deploy workflow passes it through to `serverless.yml`). The impersonated user needs access to the
target Shared Drive, and the service account needs the scopes above authorized for the domain.
