import { describe, expect, it } from 'bun:test';
import {
  formatReviewComment,
  getSeverityBadge,
  parsePullRequestPayload,
  verifyWebhookSignature,
} from '../../src/utils/index';

describe('verifyWebhookSignature', () => {
  it('should return true for valid signature', async () => {
    const payload = '{"test": true}';
    const secret = 'my-secret';

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const signature = `sha256=${Array.from(new Uint8Array(signed))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`;

    const result = await verifyWebhookSignature(payload, signature, secret);
    expect(result).toBe(true);
  });

  it('should return false for invalid signature', async () => {
    const payload = '{"test": true}';
    const secret = 'my-secret';
    const invalidSignature = 'sha256=invalid';

    const result = await verifyWebhookSignature(payload, invalidSignature, secret);
    expect(result).toBe(false);
  });

  it('should return false for wrong secret', async () => {
    const payload = '{"test": true}';
    const secret = 'my-secret';
    const wrongSecret = 'wrong-secret';

    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
    const signature = `sha256=${Array.from(new Uint8Array(signed))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')}`;

    const result = await verifyWebhookSignature(payload, signature, wrongSecret);
    expect(result).toBe(false);
  });
});

describe('parsePullRequestPayload', () => {
  it('should extract PR metadata from payload', () => {
    const payload = {
      action: 'opened',
      repository: {
        name: 'test-repo',
        owner: { login: 'test-user' },
      },
      pull_request: {
        number: 42,
        head: { sha: 'abc123' },
        draft: false,
      },
    };

    const result = parsePullRequestPayload(payload);

    expect(result.owner).toBe('test-user');
    expect(result.repo).toBe('test-repo');
    expect(result.prNumber).toBe(42);
    expect(result.headSha).toBe('abc123');
    expect(result.action).toBe('opened');
  });

  it('should handle synchronize action', () => {
    const payload = {
      action: 'synchronize',
      repository: {
        name: 'my-repo',
        owner: { login: 'my-user' },
      },
      pull_request: {
        number: 100,
        head: { sha: 'def456' },
        draft: false,
      },
    };

    const result = parsePullRequestPayload(payload);
    expect(result.action).toBe('synchronize');
    expect(result.prNumber).toBe(100);
  });
});

describe('getSeverityBadge', () => {
  it('should return correct badge for each severity', () => {
    expect(getSeverityBadge('critical')).toBe('🔴');
    expect(getSeverityBadge('warning')).toBe('🟡');
    expect(getSeverityBadge('info')).toBe('🔵');
    expect(getSeverityBadge('suggestion')).toBe('💡');
  });

  it('should return default badge for unknown severity', () => {
    expect(getSeverityBadge('unknown')).toBe('🔵');
    expect(getSeverityBadge('')).toBe('🔵');
  });
});

describe('formatReviewComment', () => {
  it('should format comment with severity badge', () => {
    const result = formatReviewComment('warning', 'This is a warning');
    expect(result).toBe('🟡 **Warning**: This is a warning');
  });

  it('should capitalize severity', () => {
    const result = formatReviewComment('critical', 'Something broke');
    expect(result).toBe('🔴 **Critical**: Something broke');
  });

  it('should handle suggestion severity', () => {
    const result = formatReviewComment('suggestion', 'Consider refactoring');
    expect(result).toBe('💡 **Suggestion**: Consider refactoring');
  });
});
