import { describe, expect, it } from 'bun:test';
import pino from 'pino';
import { ReplyHandler } from '../../src/reply-handler/index';

const logger = pino({ level: 'silent' });

describe('ReplyHandler', () => {
  const replyHandler = new ReplyHandler({}, logger);

  describe('parseIssueCommentPayload', () => {
    it('should extract PR conversation comment metadata', () => {
      const payload = {
        comment: {
          id: 123,
          body: 'Can you clarify this review?',
          created_at: new Date().toISOString(),
          user: { login: 'octocat' },
        },
        issue: {
          number: 42,
          pull_request: { url: 'https://api.github.com/repos/acme/demo/pulls/42' },
        },
        repository: {
          name: 'demo',
          owner: { login: 'acme' },
        },
      };

      const result = replyHandler.parseIssueCommentPayload(payload);

      expect(result?.commentType).toBe('issue');
      expect(result?.commentId).toBe(123);
      expect(result?.prNumber).toBe(42);
      expect(result?.owner).toBe('acme');
      expect(result?.repo).toBe('demo');
    });

    it('should ignore non-PR issue comments', () => {
      const payload = {
        comment: {
          id: 123,
          body: 'Regular issue comment',
          created_at: new Date().toISOString(),
          user: { login: 'octocat' },
        },
        issue: {
          number: 42,
        },
        repository: {
          name: 'demo',
          owner: { login: 'acme' },
        },
      };

      expect(replyHandler.parseIssueCommentPayload(payload)).toBeNull();
    });
  });

  describe('shouldProcessComment', () => {
    it('should skip nested review replies', () => {
      const shouldProcess = replyHandler.shouldProcessComment(
        {
          commentType: 'review',
          commentId: 123,
          body: 'Nested reply',
          userLogin: 'octocat',
          prNumber: 42,
          owner: 'acme',
          repo: 'demo',
          inReplyToId: 100,
          createdAt: new Date().toISOString(),
        },
        'aperio[bot]',
      );

      expect(shouldProcess).toBe(false);
    });

    it('should skip comments without a bot mention by default', () => {
      const shouldProcess = replyHandler.shouldProcessComment(
        {
          commentType: 'issue',
          commentId: 123,
          body: 'Can you explain this?',
          userLogin: 'octocat',
          prNumber: 42,
          owner: 'acme',
          repo: 'demo',
          createdAt: new Date().toISOString(),
        },
        'aperio[bot]',
      );

      expect(shouldProcess).toBe(false);
    });

    it('should process comments that mention the bot app login', () => {
      const shouldProcess = replyHandler.shouldProcessComment(
        {
          commentType: 'issue',
          commentId: 123,
          body: '@aperio can you explain this?',
          userLogin: 'octocat',
          prNumber: 42,
          owner: 'acme',
          repo: 'demo',
          createdAt: new Date().toISOString(),
        },
        'aperio[bot]',
      );

      expect(shouldProcess).toBe(true);
    });
  });
});
