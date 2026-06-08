---
plan name: pr-review-bot
plan description: GitHub App auto PR review
plan status: done
---

## Idea
Build a GitHub App (like CodeRabbit/Copilot) that automatically reviews pull requests using an OpenAI-compatible AI endpoint (https://token-plan-sgp.xiaomimimo.com/v1). When a PR is opened or updated, the app fetches the diff, sends it to the LLM for review, and posts inline review comments on specific lines. Stack: Bun/TypeScript, deployed on a self-hosted VPS.

## Implementation
- Scaffold Bun/TypeScript project with Bun.serve, Octokit, BullMQ, dotenv, pino, zod. Set up project structure: src/webhook-handler/, src/github-client/, src/ai-client/, src/review-orchestrator/, src/diff-parser/, src/utils/.
- Register GitHub App in GitHub Developer Settings. Configure webhook secret, private key, and permissions (pull_requests: write, contents: read, metadata: read).
- Implement webhook handler for pull_request events (opened, synchronize, reopened). Verify webhook signature using `X-Hub-Signature-256`, parse payload, extract PR metadata. Track `X-GitHub-Delivery` in Redis for idempotency.
- Implement GitHub API client using Octokit with JWT auth (App) → installation token per repo. Fetch files with pagination, post review comments via Create Review API using `line` + `side: "RIGHT"` for inline comments.
- Implement AI review client: send diff chunks to OpenAI-compatible endpoint with structured prompt. Parse LLM response (JSON: file, line, severity, comment) using Zod validation. Temperature 0.2.
- Implement review orchestrator: chunk large diffs to fit 800K token context window, batch AI calls, map AI line numbers to diff positions using `line` + `side: "RIGHT"`. Post review with fallback: if bulk `createReview` fails (422), verify each comment individually.
- Add idempotency: BullMQ `jobId: pr-${owner}-${repo}-${number}` to prevent duplicate processing. Redis TTL for webhook delivery IDs.
- Add configuration via .env: GITHUB_APP_ID, GITHUB_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET, AI_BASE_URL, AI_API_KEY, AI_MODEL, REDIS_URL, PORT, MAX_COMMENTS, SKIP_PATTERNS. Add health check endpoint.
- Write Dockerfile + docker-compose for VPS deployment using Bun runtime. Use Bun's built-in process management or systemd. Set up GitHub App webhook URL pointing to VPS.
- Test end-to-end: create a test repo, install the app, open a PR with intentional issues, verify inline comments appear. Handle edge cases: large PRs, binary files, force pushes.
- Add logging (pino), error handling, retry with exponential backoff for API failures, rate limiting awareness for both GitHub and AI APIs.

## Required Specs
<!-- SPECS_START -->
- review-bot-spec
- ts-coding-standard
- comment-standard
<!-- SPECS_END -->