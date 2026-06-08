# Spec: review-bot-spec

Scope: feature

# PR Review Bot — Feature Specification

## Overview
A GitHub App that automatically reviews pull requests using an AI/LLM and posts inline review comments on specific lines of code, similar to CodeRabbit or GitHub Copilot code review.

## Core Requirements

### 1. GitHub App Registration
- Register as a GitHub App with these permissions:
  - `pull_requests: read` (to read PR data)
  - `pull_requests: write` (to post reviews)
  - `contents: read` (to fetch file content)
  - `metadata: read` (basic repo access)
- Subscribe to `pull_request` events: `opened`, `synchronize`, `reopened`
- Webhook endpoint must verify signature using `X-Hub-Signature-256`

### 2. Webhook Handler
- Accept POST `/webhook` with signature verification
- Filter events: only process `pull_request` with actions `opened`, `synchronize`, `reopened`
- Extract from payload: `repository.owner.login`, `repository.name`, `pull_request.number`, `pull_request.head.sha`
- Return 200 immediately, process review asynchronously
- Track `X-GitHub-Delivery` for idempotency (skip if already processed)

### 3. GitHub API Integration
- **Fetch diff**: `GET /repos/{owner}/{repo}/pulls/{pr_number}/files` — returns file patches with line numbers
- **Fetch file content**: `GET /repos/{owner}/{repo}/contents/{path}?ref={sha}` — for context
- **Post review**: `POST /repos/{owner}/{repo}/pulls/{pr_number}/reviews` with:
  - `event: "COMMENT"` (not APPROVE/REQUEST_CHANGES)
  - `comments[]` with `path`, `line` (new file line number), `side: "RIGHT"`, `body`
- Use Octokit with JWT auth (App) → installation token per repo
- **Line mapping**: Use `line` + `side: "RIGHT"` for new/modified lines, `line` + `side: "LEFT"` for deleted lines
- Comments outside diff hunk context will fail with 422
- **Fallback**: If bulk `createReview` fails (422), post comments individually

### 4. AI Review Client
- **Endpoint**: OpenAI-compatible `POST {AI_BASE_URL}/v1/chat/completions`
- **System prompt**: Instruct LLM to act as senior code reviewer, output structured JSON
- **Response format** (enforced via Zod schema):
  ```json
  [
    {
      "file": "src/foo.ts",
      "line": 42,
      "severity": "critical|warning|info|suggestion",
      "comment": "This function lacks error handling for network failures.",
      "suggestion": "try { await fetchData(); } catch (error) { logger.error(error); }"
    }
  ]
  ```
- **Model**: Configurable via `AI_MODEL` env var
- **Temperature**: 0.2 (deterministic, focused reviews)
- **Prompt Guardrails**: See Section 12

### 5. Diff Processing & Line Mapping
- Parse GitHub's unified diff format to extract:
  - File path
  - Added/modified lines with their new file line numbers
- Only review added/modified lines (skip deletions, context lines)
- Map LLM's `line` number to GitHub API format using `line` + `side: "RIGHT"` for new/modified lines
- Use `line` + `side: "LEFT"` for deleted lines (if reviewing deletions)
- Comments can only be placed on lines within diff hunk context (otherwise 422 error)
- Skip binary files, lock files, generated files (*.min.js, package-lock.json, etc.)
- Use `minimatch` for glob pattern matching on skip patterns
- **Line number format**: Added lines prefixed with `[Line N]` in diff sent to AI

### 6. Chunking Strategy
- GitHub API returns files as array; process each file separately
- If total diff > AI context window (800K tokens):
  - Group files into chunks that fit within context limit
  - Send multiple AI requests, merge results
- Include file path + language in prompt for context
- Token estimation: 4 chars per token

### 7. Review Comment Quality
- Filter out low-confidence or generic comments from LLM
- Deduplicate comments on same file+line
- Format comment body with severity badge:
  ```
  🔴 **Critical**: This function lacks error handling for network failures.
  
  <details>
  <summary>💡 Suggested Fix</summary>
  
  ```typescript
  try { await fetchData(); } catch (error) { logger.error(error); }
  ```
  
  </details>
  ```
- Max 10 comments per review (configurable) to avoid noise
- **Severity levels**: `critical` (🔴), `warning` (🟡), `info` (🔵), `suggestion` (💡)

### 8. Configuration (Environment Variables)
| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_APP_ID` | Yes | GitHub App ID |
| `GITHUB_PRIVATE_KEY` | Yes | Base64-encoded private key (.pem) |
| `GITHUB_WEBHOOK_SECRET` | Yes | Webhook signature secret |
| `AI_BASE_URL` | Yes | AI API base URL |
| `AI_API_KEY` | Yes | AI API key (if required) |
| `AI_MODEL` | Yes | Model name/ID |
| `PORT` | No | Server port (default: 3000) |
| `MAX_COMMENTS` | No | Max comments per review (default: 10) |
| `SKIP_PATTERNS` | No | Glob patterns to skip (default: "*.lock,*.min.js,package-lock.json") |
| `BOT_USERNAME` | No | Bot's own username (default: "aperio[bot]") |
| `REPLY_ENABLED` | No | Enable reply feature (default: true) |
| `REPLY_MAX_PER_PR` | No | Max replies per PR per hour (default: 5) |
| `REPLY_DELAY_SECONDS` | No | Delay before replying (default: 30) |
| `REPLY_SKIP_BOTS` | No | Skip bot comments (default: true) |
| `REPLY_ONLY_COLLABORATORS` | No | Only reply to collaborators (default: true) |

### 9. Error Handling
- Retry AI API calls up to 3 times with exponential backoff
- If AI returns invalid JSON, log error and skip that chunk
- If GitHub API rate limited (429), wait and retry using `X-RateLimit-Reset` header
- **Fallback**: If bulk `createReview` fails (422), post comments individually
- Never fail silently — log all errors with context (request ID, repo, PR number)
- If review generation fails partially, post whatever comments succeeded

### 10. Deployment
- Docker container with Bun runtime
- Bun's built-in process management or systemd
- Health check: `GET /health` returns 200
- Reverse proxy (nginx/Cloudflare Tunnel) with HTTPS for webhook endpoint
- Logs: structured JSON (pino), stdout + file rotation

### 11. Idempotency
- **Webhook**: Track `X-GitHub-Delivery` header in Redis with TTL (24 hours). Skip processing if delivery ID already seen.
- **Queue**: Use `jobId: pr-${owner}-${repo}-${number}` in BullMQ to prevent duplicate job processing.
- **Reviews**: Include marker text `<!-- aperio-review -->` in review body to identify bot reviews. Check for existing marker before posting new review.

### 12. Prompt Guardrails

All prompts include security boundaries to prevent prompt injection attacks.

**Review Prompt Guardrails:**
- `SECURITY BOUNDARIES` section with explicit instructions
- Delimiter defense: `---UNTRUSTED CONTENT START/END---` around diff content
- `NEVER` instructions for injection defense
- Sandwich defense: reminder after untrusted content
- Role/scope constraints

**Reply Prompt Guardrails:**
- `SECURITY BOUNDARIES` section
- Delimiter defense for both comment and review context
- System prompt protection: "I can only help with code review questions"
- Sandwich defense reminder

### 13. Review Reply Handler

When a user comments on a review, the bot can reply automatically.

**Events**: `pull_request_review_comment`

**User Filtering:**
- Only reply to PR author or repository collaborators
- Skip bot comments (including own comments)
- Skip comments older than 24 hours

**Reply Flow:**
1. Add 👀 reaction to acknowledge receipt
2. Fetch original review comment for context
3. Analyze comment with AI (determine responseType: answer/clarify/acknowledge/skip)
4. Post reply to review comment thread

**Rate Limiting:**
- Max 5 replies per PR per hour
- Delay before replying (debounce: 30 seconds)

**Idempotency:**
- Track replied comment IDs in Redis with TTL (24 hours)
- Skip if already replied to this comment
