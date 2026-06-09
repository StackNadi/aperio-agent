import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';
import type CircuitBreaker from 'opossum';
import type { Logger } from 'pino';
import { createCircuitBreaker } from '../utils/circuit-breaker';

const REVIEW_MARKER = '<!-- aperio-review -->';
const GITHUB_MAX_RATE_LIMIT_ATTEMPTS = 2;
const GITHUB_RATE_LIMIT_FALLBACK_DELAY_MS = 1000;
const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Configuration for creating a GitHub client instance.
 */
export interface GitHubClientConfig {
  /** GitHub App ID from Developer Settings */
  appId: string;
  /** Base64-encoded private key (.pem) */
  privateKey: string;
  /** Repository owner (user or org) */
  owner: string;
  /** Repository name */
  repo: string;
  /** Request timeout in milliseconds. @defaultValue 20000 */
  requestTimeoutMs?: number;
}

class GitHubTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`GitHub API operation timed out: ${operation} after ${timeoutMs}ms`);
    this.name = 'GitHubTimeoutError';
  }
}

/**
 * Review comment formatted for GitHub's Pull Request Review API.
 *
 * Uses `line` + `side` for positioning (not legacy `position`).
 */
export interface ReviewComment {
  /** File path relative to repository root */
  path: string;
  /** Line number in the new file (RIGHT) or old file (LEFT) */
  line: number;
  /** Which side of the diff: "RIGHT" for new/modified, "LEFT" for deleted */
  side: 'RIGHT' | 'LEFT';
  /** Comment body text */
  body: string;
}

/**
 * GitHub API client for the PR Review Bot.
 *
 * Handles authentication via GitHub App (JWT → installation token),
 * fetching PR files with pagination, and posting review comments.
 *
 * @example
 * ```typescript
 * const client = new GitHubClient({ appId, privateKey, owner, repo }, logger);
 * const files = await client.fetchPullRequestFiles(123);
 * await client.postReview(123, sha, comments);
 * ```
 */
export class GitHubClient {
  private octokit: Octokit;
  private owner: string;
  private repo: string;
  private requestTimeoutMs: number;
  private logger: Logger;
  private circuitBreaker: CircuitBreaker<
    [(signal: AbortSignal) => Promise<unknown>, Record<string, unknown>],
    unknown
  >;

  constructor(config: GitHubClientConfig, logger: Logger) {
    this.owner = config.owner;
    this.repo = config.repo;
    this.requestTimeoutMs = config.requestTimeoutMs ?? DEFAULT_GITHUB_REQUEST_TIMEOUT_MS;
    this.logger = logger;

    this.octokit = new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: config.appId,
        privateKey: config.privateKey,
      },
    });

    this.circuitBreaker = createCircuitBreaker(
      (operation: (signal: AbortSignal) => Promise<unknown>, context: Record<string, unknown>) =>
        this.executeWithRetry(operation, context),
      'github-api',
      logger,
    );
  }

  /**
   * Gets the installation ID for this repository.
   *
   * @returns Installation ID from GitHub App installations
   * @throws {Error} If app is not installed on the repository
   */
  async getInstallationId(): Promise<number> {
    try {
      const { data } = await this.withRateLimitRetry(
        (signal) =>
          this.octokit.apps.getRepoInstallation({
            owner: this.owner,
            repo: this.repo,
            request: { signal },
          }),
        { operation: 'getRepoInstallation' },
      );
      return data.id;
    } catch (error) {
      this.logger.error(
        { error, owner: this.owner, repo: this.repo },
        'Failed to get installation ID',
      );
      throw error;
    }
  }

  /**
   * Creates an Octokit instance authenticated with an installation access token.
   *
   * @param installationId - GitHub App installation ID
   * @returns Octokit instance with installation-scoped auth
   */
  async getOctokitForInstallation(installationId: number): Promise<Octokit> {
    const { data } = await this.withRateLimitRetry(
      (signal) =>
        this.octokit.apps.createInstallationAccessToken({
          installation_id: installationId,
          request: { signal },
        }),
      { operation: 'createInstallationAccessToken', installationId },
    );

    return new Octokit({ auth: data.token });
  }

  /**
   * Fetches all files changed in a pull request with automatic pagination.
   *
   * @param prNumber - Pull request number
   * @returns Array of file objects from the PR (includes patch, status, filename)
   *
   * @see https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files
   */
  async fetchPullRequestFiles(prNumber: number): Promise<unknown[]> {
    const installationId = await this.getInstallationId();
    const installationOctokit = await this.getOctokitForInstallation(installationId);

    const files: unknown[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await this.withRateLimitRetry(
        (signal) =>
          installationOctokit.pulls.listFiles({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            per_page: perPage,
            page,
            request: { signal },
          }),
        { operation: 'listFiles', prNumber, page },
      );

      files.push(...data);

      if (data.length < perPage) break;
      page++;
    }

    this.logger.info({ fileCount: files.length, prNumber }, 'Fetched PR files');
    return files;
  }

  /**
   * Fetches the content of a file at a specific commit.
   *
   * @param path - File path relative to repository root
   * @ref - Git ref (commit SHA, branch, or tag)
   * @returns Decoded file content as UTF-8 string
   * @throws {Error} If file content cannot be decoded
   */
  async fetchFileContent(path: string, ref: string): Promise<string> {
    const installationId = await this.getInstallationId();
    const installationOctokit = await this.getOctokitForInstallation(installationId);

    try {
      const { data } = await this.withRateLimitRetry(
        (signal) =>
          installationOctokit.repos.getContent({
            owner: this.owner,
            repo: this.repo,
            path,
            ref,
            request: { signal },
          }),
        { operation: 'getContent', path, ref },
      );

      if ('content' in data && data.encoding === 'base64') {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }

      throw new Error('Unexpected content format');
    } catch (error) {
      this.logger.error({ error, path, ref }, 'Failed to fetch file content');
      throw error;
    }
  }

  /**
   * Checks whether Aperio already posted a review for this pull request commit.
   *
   * Looks for the idempotency marker in review bodies and fallback inline comments.
   *
   * @param prNumber - Pull request number
   * @param commitSha - Optional commit SHA used to scope idempotency to a PR head
   * @returns `true` when an existing Aperio review marker is found
   */
  async hasReviewMarker(prNumber: number, commitSha?: string): Promise<boolean> {
    const installationId = await this.getInstallationId();
    const installationOctokit = await this.getOctokitForInstallation(installationId);

    const hasReviewBodyMarker = await this.hasReviewBodyMarker(
      installationOctokit,
      prNumber,
      commitSha,
    );
    if (hasReviewBodyMarker) {
      return true;
    }

    return await this.hasReviewCommentMarker(installationOctokit, prNumber, commitSha);
  }

  /**
   * Posts a review with inline comments on a pull request.
   *
   * Uses `line` + `side` for positioning (not legacy `position`).
   * If bulk posting fails with 422, falls back to posting comments individually.
   *
   * @param prNumber - Pull request number
   * @param commitSha - Commit SHA to attach the review to
   * @param comments - Array of review comments with path, line, side, and body
   * @param marker - Optional marker text to identify bot reviews (for idempotency)
   *
   * @see https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request
   */
  async postReview(
    prNumber: number,
    commitSha: string,
    comments: ReviewComment[],
    marker?: string,
  ): Promise<void> {
    const installationId = await this.getInstallationId();
    const installationOctokit = await this.getOctokitForInstallation(installationId);

    const reviewBody = marker ? `${REVIEW_MARKER}\n${marker}` : REVIEW_MARKER;

    try {
      await this.withRateLimitRetry(
        (signal) =>
          installationOctokit.pulls.createReview({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            commit_id: commitSha,
            event: 'COMMENT',
            body: reviewBody,
            comments: comments.map((c) => ({
              path: c.path,
              line: c.line,
              side: c.side,
              body: c.body,
            })),
            request: { signal },
          }),
        { operation: 'createReview', prNumber },
      );

      this.logger.info({ prNumber, commentCount: comments.length }, 'Review posted');
    } catch (error) {
      const statusCode = (error as { status?: number }).status;
      if (statusCode === 422) {
        this.logger.warn(
          { prNumber },
          'Bulk review failed (422), falling back to individual comments',
        );
        await this.postCommentsIndividually(installationOctokit, prNumber, commitSha, comments);
      } else {
        this.logger.error({ error, prNumber }, 'Failed to post review');
        throw error;
      }
    }
  }

  /**
   * Fallback: posts comments individually when bulk createReview fails.
   *
   * Used when the API returns 422 (e.g., comments outside diff context).
   * Only posts comments that are valid (within diff hunk).
   */
  private async postCommentsIndividually(
    octokit: Octokit,
    prNumber: number,
    commitSha: string,
    comments: ReviewComment[],
  ): Promise<void> {
    let successCount = 0;

    for (const comment of comments) {
      try {
        await this.withRateLimitRetry(
          (signal) =>
            octokit.pulls.createReviewComment({
              owner: this.owner,
              repo: this.repo,
              pull_number: prNumber,
              commit_id: commitSha,
              path: comment.path,
              line: comment.line,
              side: comment.side,
              body: `${comment.body}\n\n${REVIEW_MARKER}`,
              request: { signal },
            }),
          { operation: 'createReviewComment', prNumber, path: comment.path, line: comment.line },
        );
        successCount++;
      } catch (error) {
        const statusCode = (error as { status?: number }).status;
        const errorMessage = (error as { message?: string }).message ?? 'Unknown error';

        this.logger.warn(
          {
            statusCode,
            errorMessage,
            path: comment.path,
            line: comment.line,
            side: comment.side,
          },
          'Skipped invalid comment',
        );
      }
    }

    this.logger.info(
      { prNumber, successCount, total: comments.length },
      'Individual comments posted',
    );

    if (successCount === 0) {
      throw new Error('No review comments were posted after fallback');
    }
  }

  /**
   * Checks if a user is a collaborator on the repository.
   *
   * @param username - GitHub username to check
   * @returns `true` if user is a collaborator
   */
  async isCollaborator(username: string): Promise<boolean> {
    const installationId = await this.getInstallationId();
    const installationOctokit = await this.getOctokitForInstallation(installationId);

    try {
      await this.withRateLimitRetry(
        (signal) =>
          installationOctokit.repos.checkCollaborator({
            owner: this.owner,
            repo: this.repo,
            username,
            request: { signal },
          }),
        { operation: 'checkCollaborator', username },
      );
      return true;
    } catch (error) {
      const statusCode = (error as { status?: number }).status;
      if (statusCode === 404) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Replies to a review comment on a pull request.
   *
   * @param prNumber - Pull request number
   * @param commentId - ID of the review comment to reply to
   * @param body - Reply body text
   * @param onPostStarted - Callback invoked immediately before the reply API call
   * @returns Created comment data
   */
  async replyToReviewComment(
    prNumber: number,
    commentId: number,
    body: string,
    onPostStarted?: () => void,
  ): Promise<unknown> {
    const installationId = await this.getInstallationId();
    const installationOctokit = await this.getOctokitForInstallation(installationId);

    try {
      onPostStarted?.();
      const { data } = await this.withRateLimitRetry(
        (signal) =>
          installationOctokit.pulls.createReplyForReviewComment({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            comment_id: commentId,
            body,
            request: { signal },
          }),
        { operation: 'createReplyForReviewComment', prNumber, commentId },
      );

      this.logger.info({ prNumber, commentId }, 'Reply posted to review comment');
      return data;
    } catch (error) {
      this.logger.error({ error, prNumber, commentId }, 'Failed to post reply');
      throw error;
    }
  }

  /**
   * Gets a review comment by ID.
   *
   * @param commentId - ID of the review comment
   * @returns Comment data with body and user info
   */
  async getReviewComment(commentId: number): Promise<{ body: string; userLogin: string }> {
    const installationId = await this.getInstallationId();
    const installationOctokit = await this.getOctokitForInstallation(installationId);

    try {
      const { data } = await this.withRateLimitRetry(
        (signal) =>
          installationOctokit.pulls.getReviewComment({
            owner: this.owner,
            repo: this.repo,
            comment_id: commentId,
            request: { signal },
          }),
        { operation: 'getReviewComment', commentId },
      );

      return {
        body: data.body,
        userLogin: data.user.login,
      };
    } catch (error) {
      this.logger.error({ error, commentId }, 'Failed to get review comment');
      throw error;
    }
  }

  /**
   * Posts a comment on a pull request (not inline).
   *
   * GitHub REST issue comments are timeline-level comments; they do not support
   * threaded replies to a specific PR conversation comment.
   *
   * @param prNumber - Pull request number
   * @param body - Comment body text
   * @param onPostStarted - Callback invoked immediately before the comment API call
   * @returns Created comment data
   */
  async createIssueComment(
    prNumber: number,
    body: string,
    onPostStarted?: () => void,
  ): Promise<unknown> {
    const installationId = await this.getInstallationId();
    const installationOctokit = await this.getOctokitForInstallation(installationId);

    try {
      onPostStarted?.();
      const { data } = await this.withRateLimitRetry(
        (signal) =>
          installationOctokit.issues.createComment({
            owner: this.owner,
            repo: this.repo,
            issue_number: prNumber,
            body,
            request: { signal },
          }),
        { operation: 'createIssueComment', prNumber },
      );

      this.logger.info({ prNumber }, 'Issue comment posted');
      return data;
    } catch (error) {
      this.logger.error({ error, prNumber }, 'Failed to post issue comment');
      throw error;
    }
  }

  /**
   * Gets the PR author's username.
   *
   * @param prNumber - Pull request number
   * @returns PR author's username
   */
  async getPullRequestAuthor(prNumber: number): Promise<string> {
    const installationId = await this.getInstallationId();
    const installationOctokit = await this.getOctokitForInstallation(installationId);

    const { data } = await this.withRateLimitRetry(
      (signal) =>
        installationOctokit.pulls.get({
          owner: this.owner,
          repo: this.repo,
          pull_number: prNumber,
          request: { signal },
        }),
      { operation: 'getPullRequest', prNumber },
    );

    return data.user.login;
  }

  /**
   * Adds a reaction to a pull request review comment.
   *
   * Used to acknowledge receipt of a user's comment (e.g., 👀 eyes reaction).
   *
   * @param commentId - Review comment ID
   * @param reaction - Reaction type ('eyes', 'rocket', 'heart', '+1', etc.)
   *
   * @see https://docs.github.com/en/rest/reactions#create-reaction-for-a-pull-request-review-comment
   */
  async addReactionToComment(commentId: number, reaction: string): Promise<void> {
    const installationId = await this.getInstallationId();
    const installationOctokit = await this.getOctokitForInstallation(installationId);

    try {
      await this.withRateLimitRetry(
        (signal) =>
          installationOctokit.reactions.createForPullRequestReviewComment({
            owner: this.owner,
            repo: this.repo,
            comment_id: commentId,
            content: reaction as
              | '+1'
              | '-1'
              | 'laugh'
              | 'confused'
              | 'heart'
              | 'hooray'
              | 'rocket'
              | 'eyes',
            request: { signal },
          }),
        { operation: 'createForPullRequestReviewComment', commentId },
      );

      this.logger.info({ commentId, reaction }, 'Reaction added to comment');
    } catch (error) {
      this.logger.debug({ error, commentId, reaction }, 'Failed to add reaction to comment');
    }
  }

  /**
   * Adds a reaction to an issue or pull request conversation comment.
   *
   * @param commentId - Issue comment ID
   * @param reaction - Reaction type ('eyes', 'rocket', 'heart', '+1', etc.)
   *
   * @see https://docs.github.com/en/rest/reactions#create-reaction-for-an-issue-comment
   */
  async addReactionToIssueComment(commentId: number, reaction: string): Promise<void> {
    const installationId = await this.getInstallationId();
    const installationOctokit = await this.getOctokitForInstallation(installationId);

    try {
      await this.withRateLimitRetry(
        (signal) =>
          installationOctokit.reactions.createForIssueComment({
            owner: this.owner,
            repo: this.repo,
            comment_id: commentId,
            content: reaction as
              | '+1'
              | '-1'
              | 'laugh'
              | 'confused'
              | 'heart'
              | 'hooray'
              | 'rocket'
              | 'eyes',
            request: { signal },
          }),
        { operation: 'createForIssueComment', commentId },
      );

      this.logger.info({ commentId, reaction }, 'Reaction added to issue comment');
    } catch (error) {
      this.logger.debug({ error, commentId, reaction }, 'Failed to add reaction to issue comment');
    }
  }

  private async hasReviewBodyMarker(
    octokit: Octokit,
    prNumber: number,
    commitSha?: string,
  ): Promise<boolean> {
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await this.withRateLimitRetry(
        (signal) =>
          octokit.pulls.listReviews({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            per_page: perPage,
            page,
            request: { signal },
          }),
        { operation: 'listReviews', prNumber, page },
      );

      const hasMarker = data.some((review) =>
        this.hasMatchingMarker(review.body, review.commit_id, commitSha),
      );
      if (hasMarker) {
        return true;
      }

      if (data.length < perPage) {
        return false;
      }

      page++;
    }
  }

  private async hasReviewCommentMarker(
    octokit: Octokit,
    prNumber: number,
    commitSha?: string,
  ): Promise<boolean> {
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await this.withRateLimitRetry(
        (signal) =>
          octokit.pulls.listReviewComments({
            owner: this.owner,
            repo: this.repo,
            pull_number: prNumber,
            per_page: perPage,
            page,
            request: { signal },
          }),
        { operation: 'listReviewComments', prNumber, page },
      );

      const hasMarker = data.some((comment) =>
        this.hasMatchingMarker(comment.body, comment.commit_id, commitSha),
      );
      if (hasMarker) {
        return true;
      }

      if (data.length < perPage) {
        return false;
      }

      page++;
    }
  }

  private hasMatchingMarker(
    body: string | null | undefined,
    itemCommitSha?: string | null,
    commitSha?: string,
  ): boolean {
    const hasMarker = body?.includes(REVIEW_MARKER) ?? false;
    const hasMatchingCommit = !commitSha || itemCommitSha === commitSha;
    return hasMarker && hasMatchingCommit;
  }

  private async withRateLimitRetry<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    context: Record<string, unknown>,
  ): Promise<T> {
    const result = await this.circuitBreaker.fire(operation, context);
    return result as T;
  }

  private async executeWithRetry<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    context: Record<string, unknown>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= GITHUB_MAX_RATE_LIMIT_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const operationName = String(context.operation ?? 'unknown');
      const timeout = setTimeout(
        () => controller.abort(new GitHubTimeoutError(operationName, this.requestTimeoutMs)),
        this.requestTimeoutMs,
      );

      try {
        return await operation(controller.signal);
      } catch (error) {
        if (attempt === GITHUB_MAX_RATE_LIMIT_ATTEMPTS || !this.isGitHubRateLimitError(error)) {
          throw error;
        }

        const delayMs = this.getRateLimitDelayMs(error);
        this.logger.warn({ error, attempt, delayMs, ...context }, 'GitHub rate limited, retrying');
        await sleep(delayMs);
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error('GitHub API call failed after rate-limit retries');
  }

  private isGitHubRateLimitError(error: unknown): boolean {
    const statusCode = (error as { status?: number }).status;
    const remaining = this.getErrorHeader(error, 'x-ratelimit-remaining');
    const retryAfter = this.getErrorHeader(error, 'retry-after');
    const message = ((error as { message?: string }).message ?? '').toLowerCase();
    const isPrimaryRateLimit = remaining === '0';
    const isSecondaryRateLimit =
      Boolean(retryAfter) ||
      message.includes('secondary rate limit') ||
      message.includes('abuse detection');

    return (
      statusCode === 429 || (statusCode === 403 && (isPrimaryRateLimit || isSecondaryRateLimit))
    );
  }

  private getRateLimitDelayMs(error: unknown): number {
    const retryAfterSeconds = Number(this.getErrorHeader(error, 'retry-after'));

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return retryAfterSeconds * 1000;
    }

    const resetSeconds = Number(this.getErrorHeader(error, 'x-ratelimit-reset'));

    if (Number.isFinite(resetSeconds) && resetSeconds > 0) {
      return Math.max(resetSeconds * 1000 - Date.now(), 0);
    }

    return GITHUB_RATE_LIMIT_FALLBACK_DELAY_MS;
  }

  private getErrorHeader(error: unknown, headerName: string): string | undefined {
    const headers = this.getErrorHeaders(error);
    const normalizedHeaderName = headerName.toLowerCase();

    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === normalizedHeaderName && value !== undefined) {
        return String(value);
      }
    }

    return undefined;
  }

  private getErrorHeaders(error: unknown): Record<string, string | number | undefined> {
    const errorWithHeaders = error as {
      headers?: Record<string, string | number | undefined>;
      response?: { headers?: Record<string, string | number | undefined> };
    };

    return errorWithHeaders.response?.headers ?? errorWithHeaders.headers ?? {};
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
