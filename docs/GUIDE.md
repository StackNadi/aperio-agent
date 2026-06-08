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

```bash
bun install
```

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

Start the app:

```bash
bun dev
```

## Docker

For Docker-based setup, see [`DOCKER.md`](./DOCKER.md).
