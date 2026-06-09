import { beforeEach, describe, expect, it, mock } from 'bun:test';
import pino from 'pino';

const logger = pino({ level: 'silent' });

/**
 * Webhook handler tests.
 *
 * Tests that require Redis connection are skipped in unit tests.
 * Run with `bun run start` and test manually with real webhook.
 */
describe('webhookHandler', () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = 'test-secret';
  });

  it('should return 401 for missing signature', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');

    const req = new Request('http://localhost:3000/webhook', {
      method: 'POST',
      body: JSON.stringify({ test: true }),
      headers: {
        'content-type': 'application/json',
      },
    });

    const response = await webhookHandler(req, logger);
    expect(response.status).toBe(401);
  });

  it('should return 401 for invalid signature', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');

    const req = new Request('http://localhost:3000/webhook', {
      method: 'POST',
      body: JSON.stringify({ test: true }),
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=invalid',
      },
    });

    const response = await webhookHandler(req, logger);
    expect(response.status).toBe(401);
  });

  it('should reject oversized webhook bodies before signature validation', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');

    const req = new Request('http://localhost:3000/webhook', {
      method: 'POST',
      body: JSON.stringify({ test: true }),
      headers: {
        'content-type': 'application/json',
      },
    });

    const response = await webhookHandler(req, logger, { maxBodyBytes: 4 });

    expect(response.status).toBe(413);
  });

  it('should mark delivery only after enqueue succeeds', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');
    const payload = createPullRequestPayload();
    const body = JSON.stringify(payload);
    const signature = await createSignature(body, 'test-secret');
    let markedDeliveryId = '';

    const response = await webhookHandler(createWebhookRequest(body, signature), logger, {
      webhookSecret: 'test-secret',
      hasDeliveryProcessed: async () => false,
      markDeliveryProcessed: async (deliveryId) => {
        markedDeliveryId = deliveryId;
      },
      reviewQueue: {
        add: mock(async () => undefined),
      },
    });

    expect(response.status).toBe(200);
    expect(markedDeliveryId).toBe('delivery-1');
  });

  it('should not mark delivery when enqueue fails', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');
    const payload = createPullRequestPayload();
    const body = JSON.stringify(payload);
    const signature = await createSignature(body, 'test-secret');
    let wasMarked = false;

    const response = await webhookHandler(createWebhookRequest(body, signature), logger, {
      webhookSecret: 'test-secret',
      hasDeliveryProcessed: async () => false,
      markDeliveryProcessed: async () => {
        wasMarked = true;
      },
      reviewQueue: {
        add: mock(async () => {
          throw new Error('queue unavailable');
        }),
      },
    });

    expect(response.status).toBe(500);
    expect(wasMarked).toBe(false);
  });

  it('should return 200 for non-pull_request events', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');
    const payload = { action: 'push', repository: { name: 'demo', owner: { login: 'acme' } } };
    const body = JSON.stringify(payload);
    const signature = await createSignature(body, 'test-secret');

    const req = new Request('http://localhost:3000/webhook', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-github-delivery': 'delivery-2',
        'x-hub-signature-256': signature,
      },
    });

    const response = await webhookHandler(req, logger, {
      webhookSecret: 'test-secret',
      hasDeliveryProcessed: async () => false,
      markDeliveryProcessed: async () => {},
    });

    expect(response.status).toBe(200);
  });

  it('should return 200 for ignored pull_request actions', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');
    const payload = {
      action: 'closed',
      repository: { name: 'demo', owner: { login: 'acme' } },
      pull_request: { number: 42, draft: false, head: { sha: 'abc123' } },
    };
    const body = JSON.stringify(payload);
    const signature = await createSignature(body, 'test-secret');

    const req = new Request('http://localhost:3000/webhook', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-3',
        'x-hub-signature-256': signature,
      },
    });

    const response = await webhookHandler(req, logger, {
      webhookSecret: 'test-secret',
      hasDeliveryProcessed: async () => false,
      markDeliveryProcessed: async () => {},
    });

    expect(response.status).toBe(200);
  });

  it('should return 200 for draft PRs', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');
    const payload = {
      action: 'opened',
      repository: { name: 'demo', owner: { login: 'acme' } },
      pull_request: { number: 42, draft: true, head: { sha: 'abc123' } },
    };
    const body = JSON.stringify(payload);
    const signature = await createSignature(body, 'test-secret');

    const req = new Request('http://localhost:3000/webhook', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'pull_request',
        'x-github-delivery': 'delivery-4',
        'x-hub-signature-256': signature,
      },
    });

    const response = await webhookHandler(req, logger, {
      webhookSecret: 'test-secret',
      hasDeliveryProcessed: async () => false,
      markDeliveryProcessed: async () => {},
    });

    expect(response.status).toBe(200);
  });

  it('should return 400 for malformed JSON after signature validation', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');
    const body = '{"action":';
    const signature = await createSignature(body, 'test-secret');

    const response = await webhookHandler(createWebhookRequest(body, signature), logger, {
      webhookSecret: 'test-secret',
      hasDeliveryProcessed: async () => false,
      markDeliveryProcessed: async () => {},
    });

    expect(response.status).toBe(400);
  });

  it('should return 400 for malformed actionable pull_request payloads', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');
    const payload = { action: 'opened', repository: { name: 'demo' } };
    const body = JSON.stringify(payload);
    const signature = await createSignature(body, 'test-secret');

    const response = await webhookHandler(createWebhookRequest(body, signature), logger, {
      webhookSecret: 'test-secret',
      hasDeliveryProcessed: async () => false,
      markDeliveryProcessed: async () => {},
    });

    expect(response.status).toBe(400);
  });

  it('should return 400 for malformed review comment payloads', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');
    const payload = { action: 'created', repository: { name: 'demo' } };
    const body = JSON.stringify(payload);
    const signature = await createSignature(body, 'test-secret');

    const response = await webhookHandler(
      createWebhookRequest(body, signature, 'pull_request_review_comment'),
      logger,
      {
        webhookSecret: 'test-secret',
        hasDeliveryProcessed: async () => false,
        markDeliveryProcessed: async () => {},
      },
    );

    expect(response.status).toBe(400);
  });

  it('should return 400 for malformed issue comment payloads', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');
    const payload = { action: 'created', repository: { name: 'demo' } };
    const body = JSON.stringify(payload);
    const signature = await createSignature(body, 'test-secret');

    const response = await webhookHandler(
      createWebhookRequest(body, signature, 'issue_comment'),
      logger,
      {
        webhookSecret: 'test-secret',
        hasDeliveryProcessed: async () => false,
        markDeliveryProcessed: async () => {},
      },
    );

    expect(response.status).toBe(400);
  });

  it('should enqueue job for valid PR events', async () => {
    const { webhookHandler } = await import('../../src/webhook-handler/index');
    const payload = createPullRequestPayload();
    const body = JSON.stringify(payload);
    const signature = await createSignature(body, 'test-secret');
    const queueAdd = mock(async () => undefined);

    const response = await webhookHandler(createWebhookRequest(body, signature), logger, {
      webhookSecret: 'test-secret',
      hasDeliveryProcessed: async () => false,
      markDeliveryProcessed: async () => {},
      reviewQueue: { add: queueAdd },
    });

    expect(response.status).toBe(200);
    expect(queueAdd).toHaveBeenCalledTimes(1);
    const addCall = queueAdd.mock.calls[0] as unknown[];
    expect(addCall[0]).toBe('review-pr');
  });
});

async function createSignature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signed = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `sha256=${Array.from(new Uint8Array(signed))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

function createWebhookRequest(body: string, signature: string, event = 'pull_request'): Request {
  return new Request('http://localhost:3000/webhook', {
    method: 'POST',
    body,
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': 'delivery-1',
      'x-hub-signature-256': signature,
    },
  });
}

function createPullRequestPayload(): Record<string, unknown> {
  return {
    action: 'opened',
    repository: {
      name: 'demo',
      owner: { login: 'acme' },
    },
    pull_request: {
      number: 42,
      draft: false,
      head: { sha: 'abc123' },
    },
  };
}
