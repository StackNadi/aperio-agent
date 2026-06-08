import { type Job, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { AiClient, type ReviewComment as AiReviewComment } from '../ai-client/index';
import { loadRuntimeConfig, type RuntimeConfig } from '../config/index';
import {
  extractAddedLines,
  formatDiffForAi,
  isBinaryFile,
  parseDiff,
  shouldSkipFile,
} from '../diff-parser/index';
import { GitHubClient, type ReviewComment } from '../github-client/index';
import type { ReviewCommentMetadata } from '../reply-handler/index';
import {
  clearReplyProcessed,
  formatReviewComment,
  isReplyRateLimitExceeded,
  type PullRequestMetadata,
} from '../utils/index';

/** Threshold in tokens before splitting files into separate AI calls */
const CONTEXT_WINDOW_TOKENS = 800_000;

/** Chars-per-token estimation for chunk size calculation */
const CHARS_PER_TOKEN = 4;

/**
 * Parsed file data ready for AI review.
 */
interface ParsedFile {
  filePath: string;
  diff: string;
  addedLines: Array<{ lineNumber: number; content: string }>;
}

interface ReviewAllChunksResult {
  comments: AiReviewComment[];
  attemptedFiles: number;
  failedFiles: number;
}

class ReplyJobError extends Error {
  hasReplyPostStarted: boolean;

  constructor(cause: unknown, hasReplyPostStarted: boolean) {
    super('Reply job failed');
    this.name = 'ReplyJobError';
    this.cause = cause;
    this.hasReplyPostStarted = hasReplyPostStarted;
  }
}

/**
 * Orchestrates the PR review pipeline.
 *
 * Coordinates between GitHub API, diff parser, and AI client to:
 * 1. Fetch changed files from a PR
 * 2. Parse diffs and extract added lines
 * 3. Group files into chunks that fit the AI context window
 * 4. Send chunks to AI for review
 * 5. Map AI line numbers to diff positions
 * 6. Post formatted review comments to GitHub
 *
 * @example
 * ```typescript
 * const orchestrator = new ReviewOrchestrator(githubClient, aiClient, logger);
 * await orchestrator.processReview(metadata);
 * ```
 */
export class ReviewOrchestrator {
  private githubClient: GitHubClient;
  private aiClient: AiClient;
  private logger: Logger;
  private maxComments: number;

  constructor(githubClient: GitHubClient, aiClient: AiClient, logger: Logger, maxComments = 10) {
    this.githubClient = githubClient;
    this.aiClient = aiClient;
    this.logger = logger;
    this.maxComments = maxComments;
  }

  /**
   * Processes a full PR review end-to-end.
   *
   * @param metadata - PR metadata from the webhook payload
   * @throws {Error} If critical steps fail (file fetch, review post)
   */
  async processReview(metadata: PullRequestMetadata): Promise<void> {
    const { owner, repo, prNumber, headSha } = metadata;

    this.logger.info({ owner, repo, prNumber }, 'Starting PR review');

    try {
      const hasExistingReview = await this.githubClient.hasReviewMarker(prNumber, headSha);
      if (hasExistingReview) {
        this.logger.info({ prNumber, headSha }, 'Review already posted for this commit, skipping');
        return;
      }

      const files = await this.githubClient.fetchPullRequestFiles(prNumber);
      const diffChunks = this.processFiles(files as Array<Record<string, unknown>>);

      if (diffChunks.length === 0) {
        this.logger.info({ prNumber }, 'No reviewable changes found');
        await this.githubClient.postReview(prNumber, headSha, []);
        return;
      }

      const chunks = this.groupFilesIntoChunks(diffChunks);
      const reviewResult = await this.reviewAllChunks(chunks, prNumber);

      if (
        reviewResult.attemptedFiles > 0 &&
        reviewResult.failedFiles === reviewResult.attemptedFiles
      ) {
        throw new Error('All AI review attempts failed');
      }

      const allComments = reviewResult.comments;
      const uniqueComments = this.deduplicateComments(allComments);
      const limitedComments = uniqueComments.slice(0, this.maxComments);

      if (limitedComments.length === 0) {
        this.logger.info({ prNumber }, 'No issues found');
        await this.githubClient.postReview(prNumber, headSha, []);
        return;
      }

      const formattedComments = this.formatComments(limitedComments);
      await this.githubClient.postReview(prNumber, headSha, formattedComments);

      this.logger.info({ prNumber, commentCount: formattedComments.length }, 'Review completed');
    } catch (error) {
      this.logger.error({ error, prNumber }, 'Review failed');
      throw error;
    }
  }

  /**
   * Filters and parses PR files into diff chunks for AI review.
   *
   * Skips: deleted files, renamed files, binary files, lock files, generated files.
   */
  private processFiles(files: Array<Record<string, unknown>>): ParsedFile[] {
    const result: ParsedFile[] = [];

    for (const file of files) {
      const filePath = file.filename as string;
      const status = file.status as string;

      if (status === 'removed' || status === 'renamed') {
        this.logger.debug({ filePath, status }, 'Skipping file');
        continue;
      }

      if (isBinaryFile(filePath)) {
        this.logger.debug({ filePath }, 'Skipping binary file');
        continue;
      }

      if (shouldSkipFile(filePath)) {
        this.logger.debug({ filePath }, 'Skipping file (matches skip pattern)');
        continue;
      }

      const patch = file.patch as string;
      if (!patch) {
        this.logger.debug({ filePath }, 'No patch content');
        continue;
      }

      const diffHunk = parseDiff(patch, filePath);
      const addedLines = extractAddedLines(diffHunk);

      if (addedLines.length === 0) {
        this.logger.debug({ filePath }, 'No added lines');
        continue;
      }

      result.push({
        filePath,
        diff: formatDiffForAi(diffHunk),
        addedLines,
      });
    }

    return result;
  }

  /**
   * Groups files into chunks that fit within the AI context window.
   *
   * Uses rough 4-chars-per-token estimation.
   */
  private groupFilesIntoChunks(files: ParsedFile[]): ParsedFile[][] {
    const chunks: ParsedFile[][] = [];
    let currentChunk: ParsedFile[] = [];
    let currentTokenCount = 0;

    for (const file of files) {
      const fileTokens = Math.ceil(file.diff.length / CHARS_PER_TOKEN);

      if (currentTokenCount + fileTokens > CONTEXT_WINDOW_TOKENS && currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = [];
        currentTokenCount = 0;
      }

      currentChunk.push(file);
      currentTokenCount += fileTokens;
    }

    if (currentChunk.length > 0) {
      chunks.push(currentChunk);
    }

    return chunks;
  }

  /**
   * Reviews all chunks and collects comments from each file.
   */
  private async reviewAllChunks(
    chunks: ParsedFile[][],
    prNumber: number,
  ): Promise<ReviewAllChunksResult> {
    const result: ReviewAllChunksResult = {
      comments: [],
      attemptedFiles: 0,
      failedFiles: 0,
    };

    for (const chunk of chunks) {
      try {
        const chunkResult = await this.reviewChunk(chunk);
        result.comments.push(...chunkResult.comments);
        result.attemptedFiles += chunkResult.attemptedFiles;
        result.failedFiles += chunkResult.failedFiles;
      } catch (error) {
        result.attemptedFiles += chunk.length;
        result.failedFiles += chunk.length;
        this.logger.error({ error, prNumber }, 'Chunk review failed, continuing...');
      }
    }

    return result;
  }

  /**
   * Reviews a single chunk by sending each file's diff to the AI.
   */
  private async reviewChunk(chunk: ParsedFile[]): Promise<ReviewAllChunksResult> {
    const result: ReviewAllChunksResult = {
      comments: [],
      attemptedFiles: 0,
      failedFiles: 0,
    };

    for (const file of chunk) {
      result.attemptedFiles++;

      try {
        const comments = await this.aiClient.reviewDiff(file.diff, file.filePath);
        const mappedComments = this.mapLineNumbers(comments, file.addedLines);
        result.comments.push(...mappedComments);
      } catch (error) {
        result.failedFiles++;
        this.logger.error({ error, filePath: file.filePath }, 'File review failed');
      }
    }

    return result;
  }

  /**
   * Maps AI line numbers to actual diff line positions.
   *
   * Falls back to content matching if exact line number doesn't match.
   * Drops comments that can't be mapped or are outside added lines.
   */
  private mapLineNumbers(
    comments: AiReviewComment[],
    addedLines: Array<{ lineNumber: number; content: string }>,
  ): AiReviewComment[] {
    const addedLineNumbers = new Set(addedLines.map((l) => l.lineNumber));

    return comments
      .map((comment) => {
        const matchingLine = addedLines.find((line) => line.lineNumber === comment.line);
        if (matchingLine) return comment;

        const contentMatch = addedLines.find((line) =>
          comment.comment
            .toLowerCase()
            .includes(line.content.trim().toLowerCase().substring(0, 20)),
        );

        if (contentMatch) {
          return { ...comment, line: contentMatch.lineNumber };
        }

        this.logger.debug({ comment }, 'Could not map line number');
        return null;
      })
      .filter((c): c is AiReviewComment => c !== null)
      .filter((c) => {
        const isInDiff = addedLineNumbers.has(c.line);
        if (!isInDiff) {
          this.logger.debug(
            { line: c.line, file: c.file },
            'Dropping comment - line not in added lines',
          );
        }
        return isInDiff;
      });
  }

  /**
   * Removes duplicate comments on the same file+line combination.
   */
  private deduplicateComments(comments: AiReviewComment[]): AiReviewComment[] {
    const seen = new Set<string>();

    return comments.filter((comment) => {
      const key = `${comment.file}:${comment.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * Formats AI comments into GitHub review comment format.
   *
   * All new/modified lines use `side: "RIGHT"` (new file version).
   * Includes optional suggestion in a <details> dropdown.
   */
  private formatComments(comments: AiReviewComment[]): ReviewComment[] {
    return comments.map((c) => ({
      path: c.file,
      line: c.line,
      side: 'RIGHT' as const,
      body: formatReviewComment(c.severity, c.comment, c.suggestion),
    }));
  }
}

/**
 * Creates and configures a BullMQ worker for processing PR review and reply jobs.
 *
 * The worker handles two job types:
 * - `review-pr`: Full PR review pipeline
 * - `reply-comment`: Reply to review comments from collaborators
 *
 * @param logger - Pino logger instance
 * @returns Configured BullMQ Worker instance
 *
 * @see https://docs.bullmq.io/guide/workers
 */
export function createReviewWorker(
  logger: Logger,
  runtimeConfig: RuntimeConfig = loadRuntimeConfig(),
): Worker {
  const redisUrl = runtimeConfig.redisUrl;

  logger.info({ redisUrl }, 'Initializing BullMQ worker');

  const aiClient = new AiClient(
    {
      baseUrl: runtimeConfig.aiBaseUrl,
      apiKey: runtimeConfig.aiApiKey,
      model: runtimeConfig.aiModel,
      timeoutMs: runtimeConfig.aiRequestTimeoutMs,
    },
    logger,
  );

  const worker = new Worker(
    'pr-review',
    async (job) => {
      if (job.name === 'review-pr') {
        const metadata = job.data as PullRequestMetadata;
        logger.info({ jobId: job.id, prNumber: metadata.prNumber }, 'Processing review job');

        const githubClient = createGitHubClient(
          metadata.owner,
          metadata.repo,
          logger,
          runtimeConfig,
        );
        const orchestrator = new ReviewOrchestrator(
          githubClient,
          aiClient,
          logger,
          runtimeConfig.maxComments,
        );
        await orchestrator.processReview(metadata);
      } else if (job.name === 'reply-comment') {
        const metadata = job.data as ReviewCommentMetadata;
        logger.info({ jobId: job.id, commentId: metadata.commentId }, 'Processing reply job');

        const githubClient = createGitHubClient(
          metadata.owner,
          metadata.repo,
          logger,
          runtimeConfig,
        );
        await processReplyJob(githubClient, aiClient, metadata, logger);
      }
    },
    {
      connection: { url: redisUrl },
      concurrency: 1,
    },
  );

  worker.on('ready', () => {
    logger.info('BullMQ worker connected to Redis and ready');
  });

  worker.on('error', (error) => {
    logger.error({ error }, 'BullMQ worker error');
  });

  worker.on('failed', (job, error) => {
    logger.error({ jobId: job?.id, error }, 'Job failed');
    void releaseReplyIdempotencyOnTerminalFailure(job, error, logger).catch((releaseError) => {
      logger.error({ error: releaseError, jobId: job?.id }, 'Failed to release reply idempotency');
    });
  });

  worker.on('completed', (job) => {
    logger.info({ jobId: job.id }, 'Job completed');
  });

  return worker;
}

/**
 * Processes a reply job by analyzing the comment and posting a response.
 *
 * Adds 👀 reaction immediately to acknowledge receipt, then analyzes and replies.
 */
async function processReplyJob(
  githubClient: GitHubClient,
  aiClient: AiClient,
  metadata: ReviewCommentMetadata,
  logger: Logger,
): Promise<void> {
  const { createReplyHandler } = await import('../reply-handler/index');
  const replyHandler = createReplyHandler(logger);
  let hasReplyPostStarted = false;

  try {
    if (metadata.inReplyToId !== undefined) {
      logger.debug({ commentId: metadata.commentId }, 'Skipping nested reply comment');
      return;
    }

    if (metadata.commentType === 'review') {
      await githubClient.addReactionToComment(metadata.commentId, 'eyes');
    } else {
      await githubClient.addReactionToIssueComment(metadata.commentId, 'eyes');
    }

    if (replyHandler.requiresCollaboratorCheck()) {
      const isCollaborator = await githubClient.isCollaborator(metadata.userLogin);
      if (!isCollaborator) {
        const prAuthor = await githubClient.getPullRequestAuthor(metadata.prNumber);
        if (metadata.userLogin !== prAuthor) {
          logger.debug(
            { user: metadata.userLogin },
            'User is not collaborator or PR author, skipping',
          );
          return;
        }
      }
    }

    const analysisPrompt = replyHandler.buildAnalysisPrompt(metadata.body);
    const aiResponse = await aiClient.getRawResponse(analysisPrompt);

    const analysis = replyHandler.parseAnalysisResponse(aiResponse);

    if (analysis.responseType === 'skip') {
      logger.debug('AI determined to skip this comment');
      return;
    }

    const isRateLimited = await isReplyRateLimitExceeded(
      metadata.owner,
      metadata.repo,
      metadata.prNumber,
      replyHandler.getMaxRepliesPerPr(),
    );

    if (isRateLimited) {
      logger.warn({ prNumber: metadata.prNumber }, 'Reply rate limit exceeded, skipping');
      return;
    }

    const formattedReply = replyHandler.formatReply(analysis.response);

    if (metadata.commentType === 'review') {
      await githubClient.replyToReviewComment(
        metadata.prNumber,
        metadata.commentId,
        formattedReply,
        () => {
          hasReplyPostStarted = true;
        },
      );
    } else {
      await githubClient.createIssueComment(metadata.prNumber, formattedReply, () => {
        hasReplyPostStarted = true;
      });
    }

    logger.info(
      {
        commentId: metadata.commentId,
        responseType: analysis.responseType,
        commentType: metadata.commentType,
      },
      'Reply posted',
    );
  } catch (error) {
    logger.error({ error, commentId: metadata.commentId }, 'Failed to process reply');
    throw new ReplyJobError(error, hasReplyPostStarted);
  }
}

async function releaseReplyIdempotencyOnTerminalFailure(
  job: Job | undefined,
  error: Error,
  logger: Logger,
): Promise<void> {
  if (job?.name !== 'reply-comment' || !isTerminalJobFailure(job)) {
    return;
  }

  const hasReplyPostStarted = (error as { hasReplyPostStarted?: boolean }).hasReplyPostStarted;

  if (hasReplyPostStarted !== false) {
    return;
  }

  const metadata = job.data as ReviewCommentMetadata;
  await clearReplyProcessed(metadata.commentId);
  logger.info(
    { commentId: metadata.commentId },
    'Reply idempotency released after terminal failure',
  );
}

function isTerminalJobFailure(job: Job): boolean {
  const attempts = job.opts.attempts ?? 1;
  return job.attemptsMade >= attempts;
}

/**
 * Creates a GitHub client configured for a specific repository.
 *
 * Decodes the base64-encoded private key from environment variables.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param logger - Pino logger instance
 * @returns Configured GitHubClient instance
 */
function createGitHubClient(
  owner: string,
  repo: string,
  logger: Logger,
  runtimeConfig: RuntimeConfig,
): GitHubClient {
  return new GitHubClient(
    {
      appId: runtimeConfig.githubAppId,
      privateKey: runtimeConfig.githubPrivateKey,
      owner,
      repo,
      requestTimeoutMs: runtimeConfig.githubRequestTimeoutMs,
    },
    logger,
  );
}
