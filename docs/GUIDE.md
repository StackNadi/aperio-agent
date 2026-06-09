# Guide

## GitHub App setup

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

## Configuration

Required values:

| Variable | Purpose |
| --- | --- |
| `GITHUB_APP_ID` | GitHub App ID |
| `GITHUB_PRIVATE_KEY` | Base64-encoded GitHub App private key PEM |
| `GITHUB_WEBHOOK_SECRET` | Webhook secret configured in the GitHub App |
| `AI_BASE_URL` | OpenAI-compatible API base URL |
| `AI_API_KEY` | API key for the AI provider |
| `AI_MODEL` | Model name sent to the AI provider |
| `REDIS_URL` | Redis endpoint used by BullMQ and idempotency tracking |

Optional values used often:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP server port |
| `LOG_LEVEL` | `info` | Pino log level |
| `MAX_COMMENTS` | `10` | Max review comments posted per PR |
| `WEBHOOK_MAX_BODY_BYTES` | `5000000` | Max webhook body size |
| `AI_CONTEXT_WINDOW_TOKENS` | `128000` | Model context window used to budget review input |
| `AI_REQUEST_TIMEOUT_MS` | `60000` | AI provider request timeout |
| `GITHUB_REQUEST_TIMEOUT_MS` | `20000` | GitHub API request timeout |
| `REPLY_ENABLED` | `true` | Enables bot replies to review or PR comments |
| `REPLY_REQUIRE_MENTION` | `true` | Requires mentioning the bot before reply handling |
| `REPLY_MAX_PER_PR` | `5` | Max replies per PR per hour |
| `REPLY_DELAY_SECONDS` | `30` | Debounce delay before reply jobs run |

## AI provider data flow

Aperio sends pull request diffs and reply context to the configured AI provider. Do not enable the app on repositories whose code cannot be shared with that provider. For private repositories, check the provider's retention, training, and logging policies first.

Aperio expects models with at least `128k` context for normal PR reviews. Smaller models can work on small PRs, but large diffs may be skipped when they exceed the input budget.

## Release verification

Before tagging a release, run:

```bash
bun lint
bun run typecheck
bun test
bun run build
```

## Docker

For Docker-based setup, see [`DOCKER.md`](./DOCKER.md).
