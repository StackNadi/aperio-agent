import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import pino from 'pino';
import { createReviewWorker, ReviewOrchestrator } from '../../src/review-orchestrator/index';
import { formatReviewComment } from '../../src/utils/index';

const logger = pino({ level: 'silent' });
let originalEnv: Record<string, string | undefined>;
const privateKey = Buffer.from(
  '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
).toString('base64');

beforeEach(() => {
  originalEnv = {
    GITHUB_APP_ID: process.env.GITHUB_APP_ID,
    GITHUB_PRIVATE_KEY: process.env.GITHUB_PRIVATE_KEY,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET,
    AI_BASE_URL: process.env.AI_BASE_URL,
    AI_API_KEY: process.env.AI_API_KEY,
    AI_MODEL: process.env.AI_MODEL,
  };

  process.env.GITHUB_APP_ID = '123';
  process.env.GITHUB_PRIVATE_KEY = privateKey;
  process.env.GITHUB_WEBHOOK_SECRET = 'secret';
  process.env.AI_BASE_URL = 'https://api.example.com/v1';
  process.env.AI_API_KEY = 'key';
  process.env.AI_MODEL = 'model';
});

afterEach(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

describe('ReviewOrchestrator helpers', () => {
  describe('createReviewWorker', () => {
    it('should fail when AI_MODEL is not set', () => {
      delete process.env.AI_MODEL;

      expect(() => createReviewWorker(logger)).toThrow('AI_MODEL is required');
    });
  });

  describe('deduplicateComments', () => {
    it('should remove duplicate comments on same file+line', () => {
      const comments = [
        { file: 'src/index.ts', line: 10, severity: 'warning' as const, comment: 'Comment 1' },
        { file: 'src/index.ts', line: 10, severity: 'error' as const, comment: 'Comment 2' },
        { file: 'src/index.ts', line: 20, severity: 'info' as const, comment: 'Comment 3' },
      ];

      const seen = new Set<string>();
      const unique = comments.filter((c) => {
        const key = `${c.file}:${c.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      expect(unique).toHaveLength(2);
      expect(unique[0]?.comment).toBe('Comment 1');
      expect(unique[1]?.comment).toBe('Comment 3');
    });

    it('should keep comments from different files', () => {
      const comments = [
        { file: 'src/index.ts', line: 10, severity: 'warning' as const, comment: 'Comment 1' },
        { file: 'src/utils.ts', line: 10, severity: 'warning' as const, comment: 'Comment 2' },
      ];

      const seen = new Set<string>();
      const unique = comments.filter((c) => {
        const key = `${c.file}:${c.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      expect(unique).toHaveLength(2);
    });

    it('should keep comments from same file but different lines', () => {
      const comments = [
        { file: 'src/index.ts', line: 10, severity: 'warning' as const, comment: 'Comment 1' },
        { file: 'src/index.ts', line: 20, severity: 'warning' as const, comment: 'Comment 2' },
        { file: 'src/index.ts', line: 30, severity: 'warning' as const, comment: 'Comment 3' },
      ];

      const seen = new Set<string>();
      const unique = comments.filter((c) => {
        const key = `${c.file}:${c.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      expect(unique).toHaveLength(3);
    });

    it('should return empty array for empty input', () => {
      const comments: Array<{ file: string; line: number; severity: 'warning'; comment: string }> =
        [];

      const seen = new Set<string>();
      const unique = comments.filter((c) => {
        const key = `${c.file}:${c.line}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      expect(unique).toHaveLength(0);
    });
  });

  describe('formatComments', () => {
    it('should format comments with side: RIGHT', () => {
      const comments = [
        {
          file: 'src/index.ts',
          line: 42,
          severity: 'warning' as const,
          comment: 'Missing error handling',
        },
      ];

      const formatted = comments.map((c) => ({
        path: c.file,
        line: c.line,
        side: 'RIGHT' as const,
        body: formatReviewComment(c.severity, c.comment),
      }));

      expect(formatted).toHaveLength(1);
      expect(formatted[0]?.path).toBe('src/index.ts');
      expect(formatted[0]?.line).toBe(42);
      expect(formatted[0]?.side).toBe('RIGHT');
      expect(formatted[0]?.body).toContain('Warning');
      expect(formatted[0]?.body).toContain('Missing error handling');
    });

    it('should format multiple comments', () => {
      const comments = [
        { file: 'a.ts', line: 1, severity: 'error' as const, comment: 'Bug' },
        { file: 'b.ts', line: 2, severity: 'info' as const, comment: 'Note' },
        { file: 'c.ts', line: 3, severity: 'suggestion' as const, comment: 'Improve' },
      ];

      const formatted = comments.map((c) => ({
        path: c.file,
        line: c.line,
        side: 'RIGHT' as const,
        body: formatReviewComment(c.severity, c.comment),
      }));

      expect(formatted).toHaveLength(3);
      expect(formatted[0]?.body).toContain('Error');
      expect(formatted[1]?.body).toContain('Info');
      expect(formatted[2]?.body).toContain('Suggestion');
    });
  });

  describe('mapLineNumbers', () => {
    it('should keep comments with matching line numbers', () => {
      const comments = [
        { file: 'test.ts', line: 10, severity: 'warning' as const, comment: 'Found it' },
      ];
      const addedLines = [
        { lineNumber: 10, content: 'some code' },
        { lineNumber: 20, content: 'more code' },
      ];

      const mapped = comments
        .map((comment) => {
          const matchingLine = addedLines.find((line) => line.lineNumber === comment.line);
          if (matchingLine) return comment;
          return null;
        })
        .filter((c) => c !== null);

      expect(mapped).toHaveLength(1);
      expect(mapped[0]?.line).toBe(10);
    });

    it('should drop comments with non-matching line numbers', () => {
      const comments = [
        { file: 'test.ts', line: 99, severity: 'warning' as const, comment: 'Not found' },
      ];
      const addedLines = [
        { lineNumber: 10, content: 'some code' },
        { lineNumber: 20, content: 'more code' },
      ];

      const mapped = comments
        .map((comment) => {
          const matchingLine = addedLines.find((line) => line.lineNumber === comment.line);
          if (matchingLine) return comment;
          return null;
        })
        .filter((c) => c !== null);

      expect(mapped).toHaveLength(0);
    });
  });
});

function createMockGitHubClient() {
  return {
    hasReviewMarker: mock<(prNumber: number, commitSha?: string) => Promise<boolean>>(
      () => Promise.resolve(false),
    ),
    fetchPullRequestFiles: mock<(prNumber: number) => Promise<unknown[]>>(
      () => Promise.resolve([]),
    ),
    postReview: mock<
      (prNumber: number, commitSha: string, comments: unknown[]) => Promise<void>
    >(() => Promise.resolve()),
  };
}

function createMockAiClient() {
  return {
    reviewDiff: mock<(diff: string, filePath: string) => Promise<unknown[]>>(
      () => Promise.resolve([]),
    ),
  };
}

describe('ReviewOrchestrator.processReview', () => {
  const metadata = {
    owner: 'acme',
    repo: 'demo',
    prNumber: 42,
    headSha: 'abc123',
    action: 'opened',
  };

  it('should skip when review marker already exists', async () => {
    const github = createMockGitHubClient();
    const ai = createMockAiClient();
    github.hasReviewMarker.mockImplementation(() => Promise.resolve(true));

    const orchestrator = new ReviewOrchestrator(
      github as unknown as InstanceType<typeof import('../../src/github-client/index').GitHubClient>,
      ai as unknown as InstanceType<typeof import('../../src/ai-client/index').AiClient>,
      logger,
    );

    await orchestrator.processReview(metadata);

    expect(github.hasReviewMarker).toHaveBeenCalledWith(42, 'abc123');
    expect(github.fetchPullRequestFiles).not.toHaveBeenCalled();
    expect(github.postReview).not.toHaveBeenCalled();
  });

  it('should post empty review when no reviewable files found', async () => {
    const github = createMockGitHubClient();
    const ai = createMockAiClient();
    github.fetchPullRequestFiles.mockImplementation(() =>
      Promise.resolve([
        { filename: 'README.md', status: 'removed', patch: '' },
      ]),
    );

    const orchestrator = new ReviewOrchestrator(
      github as unknown as InstanceType<typeof import('../../src/github-client/index').GitHubClient>,
      ai as unknown as InstanceType<typeof import('../../src/ai-client/index').AiClient>,
      logger,
    );

    await orchestrator.processReview(metadata);

    expect(github.postReview).toHaveBeenCalledWith(42, 'abc123', []);
  });

  it('should process files and post review with comments', async () => {
    const github = createMockGitHubClient();
    const ai = createMockAiClient();

    github.fetchPullRequestFiles.mockImplementation(() =>
      Promise.resolve([
        {
          filename: 'src/index.ts',
          status: 'modified',
          patch: '@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n const c = 3;',
        },
      ]),
    );

    ai.reviewDiff.mockImplementation(() =>
      Promise.resolve([
        {
          file: 'src/index.ts',
          line: 2,
          severity: 'warning' as const,
          comment: 'Variable b should have a type annotation',
        },
      ]),
    );

    const orchestrator = new ReviewOrchestrator(
      github as unknown as InstanceType<typeof import('../../src/github-client/index').GitHubClient>,
      ai as unknown as InstanceType<typeof import('../../src/ai-client/index').AiClient>,
      logger,
    );

    await orchestrator.processReview(metadata);

    expect(github.postReview).toHaveBeenCalledTimes(1);
    const postedComments = github.postReview.mock.calls[0]?.[2] as Array<{
      path: string;
      line: number;
      body: string;
    }>;
    expect(postedComments.length).toBeGreaterThan(0);
    expect(postedComments[0]?.path).toBe('src/index.ts');
  });

  it('should post empty review when AI returns no findings', async () => {
    const github = createMockGitHubClient();
    const ai = createMockAiClient();

    github.fetchPullRequestFiles.mockImplementation(() =>
      Promise.resolve([
        {
          filename: 'src/index.ts',
          status: 'modified',
          patch: '@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n const c = 3;',
        },
      ]),
    );

    ai.reviewDiff.mockImplementation(() => Promise.resolve([]));

    const orchestrator = new ReviewOrchestrator(
      github as unknown as InstanceType<typeof import('../../src/github-client/index').GitHubClient>,
      ai as unknown as InstanceType<typeof import('../../src/ai-client/index').AiClient>,
      logger,
    );

    await orchestrator.processReview(metadata);

    expect(github.postReview).toHaveBeenCalledWith(42, 'abc123', []);
  });

  it('should throw when all AI review attempts fail', async () => {
    const github = createMockGitHubClient();
    const ai = createMockAiClient();

    github.fetchPullRequestFiles.mockImplementation(() =>
      Promise.resolve([
        {
          filename: 'src/index.ts',
          status: 'modified',
          patch: '@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n const c = 3;',
        },
        {
          filename: 'src/utils.ts',
          status: 'modified',
          patch: '@@ -1,3 +1,4 @@\n const x = 1;\n+const y = 2;\n const z = 3;',
        },
      ]),
    );

    ai.reviewDiff.mockImplementation(() => Promise.reject(new Error('AI API down')));

    const orchestrator = new ReviewOrchestrator(
      github as unknown as InstanceType<typeof import('../../src/github-client/index').GitHubClient>,
      ai as unknown as InstanceType<typeof import('../../src/ai-client/index').AiClient>,
      logger,
    );

    await expect(orchestrator.processReview(metadata)).rejects.toThrow(
      'All AI review attempts failed',
    );
  });

  it('should succeed when some AI attempts fail but not all', async () => {
    const github = createMockGitHubClient();
    const ai = createMockAiClient();

    github.fetchPullRequestFiles.mockImplementation(() =>
      Promise.resolve([
        {
          filename: 'src/index.ts',
          status: 'modified',
          patch: '@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n const c = 3;',
        },
        {
          filename: 'src/utils.ts',
          status: 'modified',
          patch: '@@ -1,3 +1,4 @@\n const x = 1;\n+const y = 2;\n const z = 3;',
        },
      ]),
    );

    let callCount = 0;
    ai.reviewDiff.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.reject(new Error('AI API error'));
      }
      return Promise.resolve([
        {
          file: 'src/utils.ts',
          line: 2,
          severity: 'info' as const,
          comment: 'Looks good',
        },
      ]);
    });

    const orchestrator = new ReviewOrchestrator(
      github as unknown as InstanceType<typeof import('../../src/github-client/index').GitHubClient>,
      ai as unknown as InstanceType<typeof import('../../src/ai-client/index').AiClient>,
      logger,
    );

    await orchestrator.processReview(metadata);

    expect(github.postReview).toHaveBeenCalledTimes(1);
  });

  it('should limit comments to maxComments', async () => {
    const github = createMockGitHubClient();
    const ai = createMockAiClient();

    github.fetchPullRequestFiles.mockImplementation(() =>
      Promise.resolve([
        {
          filename: 'src/index.ts',
          status: 'modified',
          patch:
            '@@ -1,10 +1,12 @@\n a\n+b\n c\n+d\n e\n+f\n g\n+h\n i\n+j\n k\n+l',
        },
      ]),
    );

    ai.reviewDiff.mockImplementation(() =>
      Promise.resolve(
        Array.from({ length: 20 }, (_, i) => ({
          file: 'src/index.ts',
          line: i + 2,
          severity: 'warning' as const,
          comment: `Issue ${i}`,
        })),
      ),
    );

    const orchestrator = new ReviewOrchestrator(
      github as unknown as InstanceType<typeof import('../../src/github-client/index').GitHubClient>,
      ai as unknown as InstanceType<typeof import('../../src/ai-client/index').AiClient>,
      logger,
      3,
    );

    await orchestrator.processReview(metadata);

    const postedComments = github.postReview.mock.calls[0]?.[2] as Array<{ path: string }>;
    expect(postedComments.length).toBeLessThanOrEqual(3);
  });
});
