import { beforeEach, describe, expect, it, mock } from 'bun:test';
import pino from 'pino';

const logger = pino({ level: 'silent' });

function createMockOctokit(): Record<string, unknown> {
  return {
    apps: {
      getRepoInstallation: mock(() => Promise.resolve({ data: { id: 123 } })),
      createInstallationAccessToken: mock(() => Promise.resolve({ data: { token: 'ghs_test' } })),
    },
    pulls: {
      listFiles: mock(() => Promise.resolve({ data: [] })),
      createReview: mock(() => Promise.resolve({ data: {} })),
      createReviewComment: mock(() => Promise.resolve({ data: {} })),
      get: mock(() => Promise.resolve({ data: { user: { login: 'octocat' } } })),
      createReplyForReviewComment: mock(() => Promise.resolve({ data: {} })),
      getReviewComment: mock(() =>
        Promise.resolve({ data: { body: 'comment', user: { login: 'octocat' } } }),
      ),
      listReviews: mock(() => Promise.resolve({ data: [] })),
      listReviewComments: mock(() => Promise.resolve({ data: [] })),
    },
    repos: {
      getContent: mock(() =>
        Promise.resolve({
          data: {
            content: Buffer.from('file content').toString('base64'),
            encoding: 'base64',
          },
        }),
      ),
      checkCollaborator: mock(() => Promise.resolve({ data: {} })),
    },
    issues: {
      createComment: mock(() => Promise.resolve({ data: {} })),
    },
    reactions: {
      createForPullRequestReviewComment: mock(() => Promise.resolve({ data: {} })),
      createForIssueComment: mock(() => Promise.resolve({ data: {} })),
    },
  };
}

let mockOctokitInstance = createMockOctokit();

const OctokitConstructor = mock(() => mockOctokitInstance);

mock.module('@octokit/rest', () => ({ Octokit: OctokitConstructor }));
mock.module('@octokit/auth-app', () => ({ createAppAuth: mock(() => ({})) }));

const { GitHubClient } = await import('../../src/github-client/index');

function createRateLimitHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    'x-ratelimit-remaining': '0',
    'x-ratelimit-reset': String(Math.floor(Date.now() / 1000)),
    ...overrides,
  };
}

function getMethod(path: string): ReturnType<typeof mock> {
  const parts = path.split('.');
  let current: unknown = mockOctokitInstance;
  for (const part of parts) {
    current = (current as Record<string, unknown>)[part];
  }
  return current as ReturnType<typeof mock>;
}

describe('GitHubClient', () => {
  let client: InstanceType<typeof GitHubClient>;

  beforeEach(() => {
    mockOctokitInstance = createMockOctokit();
    OctokitConstructor.mockImplementation(() => mockOctokitInstance);
    client = new GitHubClient(
      {
        appId: '123',
        privateKey: Buffer.from('test-key').toString('base64'),
        owner: 'acme',
        repo: 'demo',
      },
      logger,
    );
  });

  describe('getInstallationId', () => {
    it('should return installation ID', async () => {
      getMethod('apps.getRepoInstallation').mockImplementation(() =>
        Promise.resolve({ data: { id: 456 } }),
      );

      const result = await client.getInstallationId();
      expect(result).toBe(456);
    });

    it('should retry on rate limit and succeed', async () => {
      let callCount = 0;
      getMethod('apps.getRepoInstallation').mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const error = Object.assign(new Error('Rate limited'), {
            status: 403,
            response: { headers: createRateLimitHeaders() },
          });
          return Promise.reject(error);
        }
        return Promise.resolve({ data: { id: 789 } });
      });

      const result = await client.getInstallationId();
      expect(result).toBe(789);
      expect(callCount).toBe(2);
    });

    it('should use fallback delay when no retry-after or reset headers', async () => {
      let callCount = 0;
      getMethod('apps.getRepoInstallation').mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          const error = Object.assign(new Error('Rate limited'), {
            status: 429,
            response: { headers: {} },
          });
          return Promise.reject(error);
        }
        return Promise.resolve({ data: { id: 100 } });
      });

      const result = await client.getInstallationId();
      expect(result).toBe(100);
    });

    it('should throw non-rate-limit errors immediately', async () => {
      getMethod('apps.getRepoInstallation').mockImplementation(() =>
        Promise.reject(Object.assign(new Error('Not found'), { status: 404 })),
      );

      await expect(client.getInstallationId()).rejects.toThrow('Not found');
    });

    it('should throw after max rate limit retries', async () => {
      getMethod('apps.getRepoInstallation').mockImplementation(() => {
        const error = Object.assign(new Error('Rate limited'), {
          status: 403,
          response: { headers: createRateLimitHeaders() },
        });
        return Promise.reject(error);
      });

      await expect(client.getInstallationId()).rejects.toThrow();
    });
  });

  describe('fetchPullRequestFiles', () => {
    it('should fetch files with pagination', async () => {
      const files1 = Array.from({ length: 100 }, (_, i) => ({ filename: `file${i}.ts` }));
      const files2 = [{ filename: 'file100.ts' }];

      let callCount = 0;
      getMethod('pulls.listFiles').mockImplementation(() => {
        callCount++;
        return Promise.resolve({ data: callCount === 1 ? files1 : files2 });
      });

      const result = await client.fetchPullRequestFiles(42);
      expect(result).toHaveLength(101);
    });

    it('should return empty array when no files changed', async () => {
      const result = await client.fetchPullRequestFiles(42);
      expect(result).toHaveLength(0);
    });
  });

  describe('postReview', () => {
    it('should post review successfully', async () => {
      await client.postReview(42, 'abc123', [
        { path: 'src/index.ts', line: 10, side: 'RIGHT', body: 'Review comment' },
      ]);

      expect(getMethod('pulls.createReview')).toHaveBeenCalledTimes(1);
    });

    it('should fall back to individual comments on 422', async () => {
      getMethod('pulls.createReview').mockImplementation(() =>
        Promise.reject(Object.assign(new Error('Unprocessable'), { status: 422 })),
      );
      getMethod('pulls.createReviewComment').mockImplementation(() =>
        Promise.resolve({ data: {} }),
      );

      await client.postReview(42, 'abc123', [
        { path: 'src/index.ts', line: 10, side: 'RIGHT', body: 'Comment 1' },
        { path: 'src/utils.ts', line: 20, side: 'RIGHT', body: 'Comment 2' },
      ]);

      expect(getMethod('pulls.createReviewComment')).toHaveBeenCalledTimes(2);
    });

    it('should throw on non-422 errors', async () => {
      getMethod('pulls.createReview').mockImplementation(() =>
        Promise.reject(Object.assign(new Error('Server error'), { status: 500 })),
      );

      await expect(
        client.postReview(42, 'abc123', [
          { path: 'src/index.ts', line: 10, side: 'RIGHT', body: 'Comment' },
        ]),
      ).rejects.toThrow('Server error');
    });

    it('should throw if all individual fallback comments fail', async () => {
      getMethod('pulls.createReview').mockImplementation(() =>
        Promise.reject(Object.assign(new Error('Unprocessable'), { status: 422 })),
      );
      getMethod('pulls.createReviewComment').mockImplementation(() =>
        Promise.reject(Object.assign(new Error('Invalid'), { status: 422 })),
      );

      await expect(
        client.postReview(42, 'abc123', [
          { path: 'src/index.ts', line: 10, side: 'RIGHT', body: 'Comment' },
        ]),
      ).rejects.toThrow('No review comments were posted after fallback');
    });
  });

  describe('hasReviewMarker', () => {
    it('should return true when review body contains marker', async () => {
      getMethod('pulls.listReviews').mockImplementation(() =>
        Promise.resolve({
          data: [
            {
              body: '<!-- aperio-review -->\nReview summary',
              commit_id: 'abc123',
            },
          ],
        }),
      );

      const result = await client.hasReviewMarker(42, 'abc123');
      expect(result).toBe(true);
    });

    it('should return true when review comment contains marker', async () => {
      getMethod('pulls.listReviewComments').mockImplementation(() =>
        Promise.resolve({
          data: [
            {
              body: 'Comment\n\n<!-- aperio-review -->',
              commit_id: 'abc123',
            },
          ],
        }),
      );

      const result = await client.hasReviewMarker(42, 'abc123');
      expect(result).toBe(true);
    });

    it('should return false when no marker found', async () => {
      getMethod('pulls.listReviewComments').mockImplementation(() =>
        Promise.resolve({ data: [{ body: 'Regular comment', commit_id: 'abc123' }] }),
      );

      const result = await client.hasReviewMarker(42, 'abc123');
      expect(result).toBe(false);
    });

    it('should ignore markers from different commit SHA', async () => {
      getMethod('pulls.listReviews').mockImplementation(() =>
        Promise.resolve({
          data: [{ body: '<!-- aperio-review -->', commit_id: 'old-sha' }],
        }),
      );

      const result = await client.hasReviewMarker(42, 'new-sha');
      expect(result).toBe(false);
    });
  });

  describe('isCollaborator', () => {
    it('should return true for collaborators', async () => {
      const result = await client.isCollaborator('octocat');
      expect(result).toBe(true);
    });

    it('should return false for non-collaborators', async () => {
      getMethod('repos.checkCollaborator').mockImplementation(() =>
        Promise.reject(Object.assign(new Error('Not found'), { status: 404 })),
      );

      const result = await client.isCollaborator('random-user');
      expect(result).toBe(false);
    });

    it('should throw on non-404 errors', async () => {
      getMethod('repos.checkCollaborator').mockImplementation(() =>
        Promise.reject(Object.assign(new Error('Server error'), { status: 500 })),
      );

      await expect(client.isCollaborator('octocat')).rejects.toThrow('Server error');
    });
  });

  describe('getPullRequestAuthor', () => {
    it('should return PR author username', async () => {
      const result = await client.getPullRequestAuthor(42);
      expect(result).toBe('octocat');
    });
  });
});
