# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-06-10

### Fixed

- Parse Redis URLs into BullMQ connection options so Docker Compose service names resolve correctly.
- Return `400` for malformed GitHub webhook payloads instead of throwing during event handling.
- Drop AI review comments that point to a different file or to lines outside the added diff.
- Skip file diffs that exceed the configured AI input budget.
- Stop logging raw AI responses, GitHub error payloads, Redis credentials, and review body previews.

### Changed

- Set the default review context setting to `128000` tokens through `AI_CONTEXT_WINDOW_TOKENS`.
- Validate reply handler settings through startup config.
- Use JSON Pino logs when `NODE_ENV=production`.
- Let production Compose read `REDIS_URL` from the selected env file.

### Documentation

- Document Redis setup, AI provider data flow, model context settings, and release verification commands.

## [1.0.0] - 2026-06-07

### Added

#### Core Features
- GitHub App webhook handler with HMAC SHA-256 signature verification
- AI-powered code review using OpenAI-compatible API (configurable model)
- Inline review comments posted to pull requests via GitHub API
- BullMQ worker for asynchronous review job processing
- Automatic diff parsing with added line extraction
- File chunking to fit AI context window (800K tokens)
- Review comment deduplication and configurable max comments limit

#### Reply Handler
- AI-powered reply to user comments on bot reviews
- Bot mention detection (`@aperio` or `@aperio[bot]`)
- Collaborator and PR author access control
- Per-PR reply rate limiting (configurable max per hour)
- Debounce delay before posting replies
- Nested reply detection to prevent infinite loops

#### Production Readiness
- Graceful shutdown with SIGTERM/SIGINT handling
- Circuit breaker pattern for AI and GitHub API clients (opossum)
- Health check endpoint (`GET /health`)
- Readiness check endpoint with Redis ping (`GET /ready`)
- Structured logging with Pino (configurable log level)
- Webhook body size limiting (configurable max bytes)
- Webhook delivery idempotency tracking (Redis, 24h TTL)
- Reply comment idempotency tracking (Redis, 24h TTL)
- Request timeouts for AI (60s) and GitHub (20s) APIs
- Retry with exponential backoff for transient errors
- Rate limit handling with retry-after header support

#### Configuration
- Environment variable validation on startup
- `.env.example` with all configuration options documented
- Docker support (Dockerfile + docker-compose.yml for dev and prod)
- Configurable skip patterns for file review (glob patterns)
- Configurable severity levels (critical, warning, info, suggestion)

#### Testing
- 127 tests across 11 test files
- Unit tests for all major components
- Webhook signature verification tests
- AI client retry and timeout tests
- Circuit breaker state transition tests
- Diff parser and file skip pattern tests
- Reply handler and comment parsing tests

### Security
- Webhook signature verification with timing-safe comparison
- Prompt injection guardrails in AI prompts
- Environment variable encryption support (dotenvx)
- No secrets committed to repository
