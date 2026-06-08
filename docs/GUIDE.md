# Guide

## GitHub App

Create a GitHub App from GitHub Developer settings. Use your app URL or repository URL as the homepage URL.

Enable webhooks and set the webhook URL to:

`https://your-domain.com/webhook`

For local development, you can expose your machine with ngrok or Cloudflare Tunnel and use that public URL as the webhook URL.

Set a webhook secret and enable SSL verification.

Give the app these repository permissions:

- Pull requests: Read and write
- Issues: Read and write
- Contents: Read
- Metadata: Read

Subscribe to these events:

- Pull request
- Pull request review comment
- Issue comment

After creating the app, generate a private key and install the app on the repositories you want to review. Save the App ID, private key, and webhook secret. Base64 encode the private key before setting `GITHUB_PRIVATE_KEY`.

## App setup

Install dependencies:

`bun install`

Set the required env vars:

`GITHUB_APP_ID`, `GITHUB_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`

Common optional env vars:

- `REDIS_URL`: defaults to `redis://localhost:6379`
- `PORT`: defaults to `3000`
- `WEBHOOK_MAX_BODY_BYTES`: defaults to `5000000`
- `AI_REQUEST_TIMEOUT_MS`: defaults to `60000`
- `GITHUB_REQUEST_TIMEOUT_MS`: defaults to `20000`
- `SKIP_PATTERNS`: comma-separated minimatch patterns for files to skip
- `REPLY_REQUIRE_MENTION`: defaults to `true`

Start the app:

`bun dev`

## Docker

For Docker-based setup, see [`DOCKER.md`](./DOCKER.md).
