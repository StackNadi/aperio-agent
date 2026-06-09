import type { Logger } from 'pino';
import { ZodError, z } from 'zod';
import {
  createReplyHandler,
  type ReplyHandler,
  type ReplyHandlerConfig,
  type ReviewCommentMetadata,
} from '../reply-handler/index';
import {
  clearReplyProcessed,
  getReviewQueue,
  hasDeliveryProcessed,
  isReplyProcessed,
  markDeliveryProcessed,
  parsePullRequestPayload,
  verifyWebhookSignature,
} from '../utils/index';

/**
 * GitHub pull request actions that trigger a review.
 */
const VALID_ACTIONS = ['opened', 'synchronize', 'reopened'] as const;

const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 5_000_000;

const webhookActionSchema = z.object({
  action: z.string().min(1),
});

const pullRequestDraftSchema = z.object({
  pull_request: z.object({
    draft: z.boolean(),
    number: z.number().int().positive().optional(),
  }),
});

interface ReviewQueueLike {
  add(name: string, data: unknown, options: Record<string, unknown>): Promise<unknown>;
}

/**
 * Optional dependencies and validated settings for webhook handling.
 */
export interface WebhookHandlerOptions {
  /** Webhook secret used for HMAC verification */
  webhookSecret?: string;
  /** Maximum accepted request body size in bytes */
  maxBodyBytes?: number;
  /** Queue implementation used for review and reply jobs */
  reviewQueue?: ReviewQueueLike;
  /** Validated reply handler configuration */
  replyConfig?: Partial<ReplyHandlerConfig>;
  /** Checks whether a delivery ID was already accepted */
  hasDeliveryProcessed?: (deliveryId: string) => Promise<boolean>;
  /** Marks a delivery ID as accepted */
  markDeliveryProcessed?: (deliveryId: string) => Promise<void>;
}

/**
 * Handles incoming GitHub webhook requests.
 *
 * Workflow:
 * 1. Verify `X-Hub-Signature-256` header against webhook secret
 * 2. Track `X-GitHub-Delivery` for idempotency (skip if already processed)
 * 3. Route by event type:
 *    - `pull_request` → enqueue review job
 *    - `pull_request_review_comment` → process inline reply
 *    - `issue_comment` → process PR conversation reply
 * 4. Skip draft PRs
 *
 * Returns 200 immediately; actual processing runs asynchronously.
 *
 * @param req - Incoming HTTP request
 * @param logger - Pino logger instance
 * @returns HTTP response (200 for accepted, 401 for invalid signature, 500 for errors)
 */
export async function webhookHandler(
  req: Request,
  logger: Logger,
  options: WebhookHandlerOptions = {},
): Promise<Response> {
  try {
    const rawBodyResult = await readWebhookBody(req, getMaxBodyBytes(options));

    if (rawBodyResult instanceof Response) {
      return rawBodyResult;
    }

    const rawBody = rawBodyResult;
    const signature = req.headers.get('x-hub-signature-256');
    const deliveryId = req.headers.get('x-github-delivery');

    if (!signature) {
      logger.warn('Missing webhook signature');
      return new Response('Missing signature', { status: 401 });
    }

    const webhookSecret = options.webhookSecret ?? process.env.GITHUB_WEBHOOK_SECRET;
    if (!webhookSecret) {
      logger.error('GITHUB_WEBHOOK_SECRET not configured');
      return new Response('Server misconfigured', { status: 500 });
    }

    const isValid = await verifyWebhookSignature(rawBody, signature, webhookSecret);
    if (!isValid) {
      logger.warn('Invalid webhook signature');
      return new Response('Invalid signature', { status: 401 });
    }

    if (deliveryId) {
      const alreadyProcessed = await (options.hasDeliveryProcessed ?? hasDeliveryProcessed)(
        deliveryId,
      );
      if (alreadyProcessed) {
        logger.debug({ deliveryId }, 'Duplicate delivery, skipping');
        return new Response('OK', { status: 200 });
      }
    }

    const payloadResult = parseWebhookJson(rawBody, logger);

    if (payloadResult instanceof Response) {
      return payloadResult;
    }

    const payload = payloadResult;
    const event = req.headers.get('x-github-event');
    const response = await routeWebhookEvent(payload, event, logger, options);

    if (deliveryId && response.status < 500) {
      await (options.markDeliveryProcessed ?? markDeliveryProcessed)(deliveryId);
    }

    return response;
  } catch (error) {
    logger.error({ error }, 'Webhook handler error');
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function routeWebhookEvent(
  payload: Record<string, unknown>,
  event: string | null,
  logger: Logger,
  options: WebhookHandlerOptions,
): Promise<Response> {
  if (event === 'pull_request') {
    return await handlePullRequestEvent(payload, logger, options);
  }

  if (event === 'pull_request_review_comment') {
    return await handleReviewCommentEvent(payload, logger, options);
  }

  if (event === 'issue_comment') {
    return await handleIssueCommentEvent(payload, logger, options);
  }

  logger.debug({ event }, 'Ignoring event type');
  return new Response('OK', { status: 200 });
}

/**
 * Handles pull_request events (opened, synchronize, reopened).
 */
async function handlePullRequestEvent(
  payload: Record<string, unknown>,
  logger: Logger,
  options: WebhookHandlerOptions,
): Promise<Response> {
  const actionResult = webhookActionSchema.safeParse(payload);

  if (!actionResult.success) {
    return invalidWebhookPayloadResponse('pull_request', actionResult.error, logger);
  }

  const action = actionResult.data.action;

  if (!VALID_ACTIONS.includes(action as (typeof VALID_ACTIONS)[number])) {
    logger.debug({ action }, 'Ignoring pull_request action');
    return new Response('OK', { status: 200 });
  }

  const draftResult = pullRequestDraftSchema.safeParse(payload);
  if (draftResult.success && draftResult.data.pull_request.draft) {
    logger.info({ pr: draftResult.data.pull_request.number }, 'Skipping draft PR');
    return new Response('OK', { status: 200 });
  }

  const prMetadataResult = parsePayloadSafely(() => parsePullRequestPayload(payload));

  if (!prMetadataResult.success) {
    return invalidWebhookPayloadResponse('pull_request', prMetadataResult.error, logger);
  }

  const prMetadata = prMetadataResult.data;
  logger.info(prMetadata, 'PR metadata extracted');

  const jobId = `pr-${prMetadata.owner}-${prMetadata.repo}-${prMetadata.prNumber}-${prMetadata.headSha}`;
  await (options.reviewQueue ?? getReviewQueue()).add('review-pr', prMetadata, {
    jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  });

  logger.info({ jobId }, 'Review job enqueued');
  return new Response('OK', { status: 200 });
}

/**
 * Handles pull_request_review_comment events (comments on reviews).
 */
async function handleReviewCommentEvent(
  payload: Record<string, unknown>,
  logger: Logger,
  options: WebhookHandlerOptions,
): Promise<Response> {
  const replyHandler = createReplyHandler(logger, options.replyConfig);
  const actionResult = webhookActionSchema.safeParse(payload);

  if (!actionResult.success) {
    return invalidWebhookPayloadResponse('pull_request_review_comment', actionResult.error, logger);
  }

  const action = actionResult.data.action;

  if (action !== 'created') {
    logger.debug({ action }, 'Ignoring review comment action');
    return new Response('OK', { status: 200 });
  }

  const commentMetadataResult = parsePayloadSafely(() =>
    replyHandler.parseReviewCommentPayload(payload),
  );

  if (!commentMetadataResult.success) {
    return invalidWebhookPayloadResponse(
      'pull_request_review_comment',
      commentMetadataResult.error,
      logger,
    );
  }

  const commentMetadata = commentMetadataResult.data;

  return await enqueueReplyJob(commentMetadata, replyHandler, logger, options);
}

/**
 * Handles issue_comment events for pull request conversation comments.
 */
async function handleIssueCommentEvent(
  payload: Record<string, unknown>,
  logger: Logger,
  options: WebhookHandlerOptions,
): Promise<Response> {
  const replyHandler = createReplyHandler(logger, options.replyConfig);
  const actionResult = webhookActionSchema.safeParse(payload);

  if (!actionResult.success) {
    return invalidWebhookPayloadResponse('issue_comment', actionResult.error, logger);
  }

  const action = actionResult.data.action;

  if (action !== 'created') {
    logger.debug({ action }, 'Ignoring issue comment action');
    return new Response('OK', { status: 200 });
  }

  const commentMetadataResult = parsePayloadSafely(() =>
    replyHandler.parseIssueCommentPayload(payload),
  );

  if (!commentMetadataResult.success) {
    return invalidWebhookPayloadResponse('issue_comment', commentMetadataResult.error, logger);
  }

  const commentMetadata = commentMetadataResult.data;

  if (!commentMetadata) {
    logger.debug('Ignoring non-PR issue comment');
    return new Response('OK', { status: 200 });
  }

  return await enqueueReplyJob(commentMetadata, replyHandler, logger, options);
}

/**
 * Enqueues a debounced reply job if the comment passes local filters.
 */
async function enqueueReplyJob(
  commentMetadata: ReviewCommentMetadata,
  replyHandler: ReplyHandler,
  logger: Logger,
  options: WebhookHandlerOptions,
): Promise<Response> {
  logger.info(
    {
      commentId: commentMetadata.commentId,
      user: commentMetadata.userLogin,
      pr: commentMetadata.prNumber,
      commentType: commentMetadata.commentType,
    },
    'Reply comment received',
  );

  if (
    !replyHandler.shouldProcessComment(commentMetadata, process.env.BOT_USERNAME ?? 'aperio[bot]')
  ) {
    return new Response('OK', { status: 200 });
  }

  const alreadyProcessed = await isReplyProcessed(commentMetadata.commentId);
  if (alreadyProcessed) {
    logger.debug({ commentId: commentMetadata.commentId }, 'Duplicate reply comment, skipping');
    return new Response('OK', { status: 200 });
  }

  const jobId = `reply-${commentMetadata.commentId}`;
  try {
    await (options.reviewQueue ?? getReviewQueue()).add('reply-comment', commentMetadata, {
      jobId,
      delay: replyHandler.getDelayMs(),
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400 },
    });
  } catch (error) {
    await clearReplyProcessed(commentMetadata.commentId);
    throw error;
  }

  logger.info({ jobId, commentId: commentMetadata.commentId }, 'Reply job enqueued');
  return new Response('OK', { status: 200 });
}

function getMaxBodyBytes(options: WebhookHandlerOptions): number {
  if (options.maxBodyBytes !== undefined) {
    return options.maxBodyBytes;
  }

  const configuredMaxBodyBytes = Number(process.env.WEBHOOK_MAX_BODY_BYTES);

  if (Number.isInteger(configuredMaxBodyBytes) && configuredMaxBodyBytes > 0) {
    return configuredMaxBodyBytes;
  }

  return DEFAULT_WEBHOOK_MAX_BODY_BYTES;
}

type PayloadParseResult<T> = { success: true; data: T } | { success: false; error: unknown };

function parsePayloadSafely<T>(parse: () => T): PayloadParseResult<T> {
  try {
    return { success: true, data: parse() };
  } catch (error) {
    return { success: false, error };
  }
}

function invalidWebhookPayloadResponse(event: string, error: unknown, logger: Logger): Response {
  logger.warn(
    {
      event,
      validationIssueCount: error instanceof ZodError ? error.issues.length : undefined,
    },
    'Invalid webhook payload',
  );

  return new Response('Invalid payload', { status: 400 });
}

function parseWebhookJson(rawBody: string, logger: Logger): Record<string, unknown> | Response {
  let payload: unknown;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    logger.warn('Invalid webhook JSON');
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!isRecord(payload)) {
    logger.warn('Webhook payload must be a JSON object');
    return new Response('Invalid payload', { status: 400 });
  }

  return payload;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readWebhookBody(req: Request, maxBodyBytes: number): Promise<string | Response> {
  const contentLength = Number(req.headers.get('content-length'));

  if (Number.isFinite(contentLength) && contentLength > maxBodyBytes) {
    return new Response('Payload Too Large', { status: 413 });
  }

  const rawBody = await req.text();

  if (Buffer.byteLength(rawBody, 'utf-8') > maxBodyBytes) {
    return new Response('Payload Too Large', { status: 413 });
  }

  return rawBody;
}
