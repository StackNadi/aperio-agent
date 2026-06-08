import { Queue } from 'bullmq';
import Redis from 'ioredis';

/**
 * Metadata extracted from a GitHub pull request webhook payload.
 */
export interface PullRequestMetadata {
  /** Repository owner username */
  owner: string;
  /** Repository name */
  repo: string;
  /** Pull request number */
  prNumber: number;
  /** HEAD commit SHA of the pull request */
  headSha: string;
  /** Webhook action that triggered the event */
  action: string;
}

/**
 * Review comment formatted for GitHub's Create Review API.
 *
 * Uses `line` + `side` for positioning (not legacy `position`).
 */
export interface FormattedReviewComment {
  /** File path relative to repository root */
  path: string;
  /** Line number in the new file (RIGHT) or old file (LEFT) */
  line: number;
  /** Which side of the diff: "RIGHT" for new/modified, "LEFT" for deleted */
  side: 'RIGHT' | 'LEFT';
  /** Comment body with severity badge */
  body: string;
}

/**
 * Supported severity levels for review comments.
 */
export type Severity = 'critical' | 'warning' | 'info' | 'suggestion';

const SEVERITY_BADGES: Record<Severity, string> = {
  critical: '🔴',
  warning: '🟡',
  info: '🔵',
  suggestion: '💡',
};

const DEFAULT_REDIS_URL = 'redis://localhost:6379';

/** TTL for webhook delivery ID tracking (24 hours in seconds) */
const DELIVERY_ID_TTL = 86400;

/** TTL for reply comment idempotency tracking (24 hours in seconds) */
const REPLY_ID_TTL = 86400;

/** TTL for per-PR reply rate limiting (1 hour in seconds) */
const REPLY_RATE_LIMIT_TTL = 3600;

/**
 * Gets the Redis URL from environment or falls back to default.
 */
function getRedisUrl(): string {
  return process.env.REDIS_URL ?? DEFAULT_REDIS_URL;
}

/**
 * Redis client for idempotency tracking and caching.
 *
 * Initialized lazily to avoid connection errors during testing.
 */
let _redis: Redis | null = null;

/**
 * Gets the Redis client instance, creating it if needed.
 *
 * @returns Redis client connected to the configured REDIS_URL
 */
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(getRedisUrl());
  }
  return _redis;
}

/**
 * BullMQ queue for async PR review jobs.
 *
 * Initialized lazily to avoid connection errors during testing.
 *
 * @see https://docs.bullmq.io/guide/queues
 */
let _reviewQueue: Queue | null = null;

/**
 * Gets the BullMQ queue instance, creating it if needed.
 *
 * @returns BullMQ Queue for pr-review jobs
 */
export function getReviewQueue(): Queue {
  if (!_reviewQueue) {
    _reviewQueue = new Queue('pr-review', {
      connection: {
        url: getRedisUrl(),
      },
    });
  }
  return _reviewQueue;
}

/**
 * Checks whether a webhook delivery ID was already accepted.
 *
 * Reads Redis without changing state so callers can mark only after work is accepted.
 *
 * @param deliveryId - GitHub delivery ID from `X-GitHub-Delivery` header
 * @returns `true` if this delivery was already accepted
 */
export async function hasDeliveryProcessed(deliveryId: string): Promise<boolean> {
  const key = `delivery:${deliveryId}`;
  const result = await getRedis().exists(key);
  return result === 1;
}

/**
 * Marks a webhook delivery ID as accepted.
 *
 * @param deliveryId - GitHub delivery ID from `X-GitHub-Delivery` header
 */
export async function markDeliveryProcessed(deliveryId: string): Promise<void> {
  const key = `delivery:${deliveryId}`;
  await getRedis().set(key, '1', 'EX', DELIVERY_ID_TTL);
}

/**
 * Checks if a comment reply has already been queued or processed.
 *
 * Uses Redis SET with TTL to track comment IDs and prevent duplicate replies.
 *
 * @param commentId - GitHub comment ID from the webhook payload
 * @returns `true` if this comment was already seen and should be skipped
 */
export async function isReplyProcessed(commentId: number): Promise<boolean> {
  const key = `reply:${commentId}`;
  const result = await getRedis().set(key, '1', 'EX', REPLY_ID_TTL, 'NX');
  return result === null;
}

/**
 * Clears reply idempotency for a comment after enqueue failure.
 *
 * @param commentId - GitHub comment ID from the webhook payload
 */
export async function clearReplyProcessed(commentId: number): Promise<void> {
  const key = `reply:${commentId}`;
  await getRedis().del(key);
}

/**
 * Increments the per-PR reply counter and reports whether the limit is exceeded.
 *
 * @param owner - Repository owner username
 * @param repo - Repository name
 * @param prNumber - Pull request number
 * @param maxReplies - Maximum replies allowed per hour for this PR
 * @returns `true` if the current reply should be skipped due to rate limiting
 */
export async function isReplyRateLimitExceeded(
  owner: string,
  repo: string,
  prNumber: number,
  maxReplies: number,
): Promise<boolean> {
  const key = `reply-rate:${owner}:${repo}:${prNumber}`;
  const redis = getRedis();
  const count = await redis.incr(key);

  if (count === 1) {
    await redis.expire(key, REPLY_RATE_LIMIT_TTL);
  }

  return count > maxReplies;
}

/**
 * Verifies webhook signature using HMAC SHA-256.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param payload - Raw request body as string
 * @param signature - Value of `X-Hub-Signature-256` header
 * @param secret - Webhook secret configured in GitHub App settings
 * @returns `true` if signature is valid
 *
 * @see https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expectedSignature = `sha256=${Array.from(new Uint8Array(signed))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;

  return timingSafeEqual(signature, expectedSignature);
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 *
 * XORs each character to produce 0 only if all characters match.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}

/**
 * Extracts PR metadata from a GitHub webhook payload.
 *
 * @param payload - Parsed webhook JSON payload
 * @returns Structured PR metadata for the review pipeline
 * @throws {Error} If required fields are missing from payload
 */
export function parsePullRequestPayload(payload: unknown): PullRequestMetadata {
  const data = payload as Record<string, unknown>;
  const repository = data.repository as Record<string, unknown>;
  const owner = repository.owner as Record<string, unknown>;
  const pullRequest = data.pull_request as Record<string, unknown>;
  const head = pullRequest.head as Record<string, unknown>;

  return {
    owner: owner.login as string,
    repo: repository.name as string,
    prNumber: pullRequest.number as number,
    headSha: head.sha as string,
    action: data.action as string,
  };
}

/**
 * Returns a health check response.
 *
 * @returns JSON response with `status: "ok"` and timestamp
 */
export function healthHandler(): Response {
  return new Response(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Returns a readiness response after checking Redis connectivity.
 *
 * @returns JSON response with readiness status
 */
export async function readinessHandler(): Promise<Response> {
  try {
    await getRedis().ping();

    return new Response(JSON.stringify({ status: 'ready', timestamp: new Date().toISOString() }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch {
    return new Response(
      JSON.stringify({ status: 'not_ready', timestamp: new Date().toISOString() }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}

/**
 * Closes the Redis client connection if it was initialized.
 *
 * Safe to call multiple times; no-op if Redis was never created.
 */
export async function closeRedis(): Promise<void> {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}

/**
 * Closes the BullMQ review queue if it was initialized.
 *
 * Safe to call multiple times; no-op if queue was never created.
 */
export async function closeReviewQueue(): Promise<void> {
  if (_reviewQueue) {
    await _reviewQueue.close();
    _reviewQueue = null;
  }
}

/**
 * Returns the emoji badge for a severity level.
 *
 * @param severity - Severity level string
 * @returns Emoji badge, defaults to 🔵 for unknown severity
 */
export function getSeverityBadge(severity: string): string {
  return SEVERITY_BADGES[severity as Severity] ?? SEVERITY_BADGES.info;
}

/**
 * Formats a review comment with severity badge and optional suggestion dropdown.
 *
 * @param severity - Severity level (error, warning, info, suggestion)
 * @param comment - Raw comment text
 * @param suggestion - Optional code fix suggestion
 * @returns Formatted string with severity badge and optional <details> dropdown
 */
export function formatReviewComment(
  severity: string,
  comment: string,
  suggestion?: string,
): string {
  const badge = getSeverityBadge(severity);
  const capitalizedSeverity = severity.charAt(0).toUpperCase() + severity.slice(1);

  let body = `${badge} **${capitalizedSeverity}**: ${comment}`;

  if (suggestion) {
    body += `\n\n<details>\n<summary>💡 Suggested Fix</summary>\n\n\`\`\`typescript\n${suggestion}\n\`\`\`\n\n</details>`;
  }

  return body;
}
