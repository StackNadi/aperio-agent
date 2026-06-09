import { describe, expect, it } from 'bun:test';
import { loadRuntimeConfig } from '../../src/config/index';

const privateKey = Buffer.from(
  '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
).toString('base64');

const validEnv = {
  GITHUB_APP_ID: '123',
  GITHUB_PRIVATE_KEY: privateKey,
  GITHUB_WEBHOOK_SECRET: 'secret',
  AI_BASE_URL: 'https://api.example.com/v1',
  AI_API_KEY: 'key',
  AI_MODEL: 'model',
};

describe('loadRuntimeConfig', () => {
  it('should load required env vars and defaults', () => {
    const config = loadRuntimeConfig(validEnv);

    expect(config.githubAppId).toBe('123');
    expect(config.aiModel).toBe('model');
    expect(config.redisUrl).toBe('redis://localhost:6379');
    expect(config.port).toBe(3000);
    expect(config.maxComments).toBe(10);
    expect(config.webhookMaxBodyBytes).toBe(5_000_000);
    expect(config.aiRequestTimeoutMs).toBe(60_000);
    expect(config.githubRequestTimeoutMs).toBe(20_000);
    expect(config.aiContextWindowTokens).toBe(128_000);
    expect(config.replyConfig.maxRepliesPerPr).toBe(5);
    expect(config.replyConfig.delaySeconds).toBe(30);
    expect(config.replyConfig.requireMention).toBe(true);
  });

  it('should fail when AI_MODEL is missing', () => {
    expect(() => loadRuntimeConfig({ ...validEnv, AI_MODEL: undefined })).toThrow(
      'AI_MODEL is required',
    );
  });

  it('should fail when private key is not a base64 PEM', () => {
    expect(() => loadRuntimeConfig({ ...validEnv, GITHUB_PRIVATE_KEY: 'not-a-pem' })).toThrow(
      'GITHUB_PRIVATE_KEY must be a base64-encoded PEM private key',
    );
  });

  it('should fail when timeout values are invalid', () => {
    expect(() => loadRuntimeConfig({ ...validEnv, AI_REQUEST_TIMEOUT_MS: '0' })).toThrow(
      'AI_REQUEST_TIMEOUT_MS must be an integer between 1000 and 300000',
    );
  });

  it('should load validated review and reply env vars', () => {
    const config = loadRuntimeConfig({
      ...validEnv,
      AI_CONTEXT_WINDOW_TOKENS: '200000',
      REPLY_ENABLED: 'false',
      REPLY_MAX_PER_PR: '10',
      REPLY_DELAY_SECONDS: '5',
      REPLY_SKIP_BOTS: 'false',
      REPLY_ONLY_COLLABORATORS: 'false',
      REPLY_REQUIRE_MENTION: 'false',
    });

    expect(config.aiContextWindowTokens).toBe(200_000);
    expect(config.replyConfig.isEnabled).toBe(false);
    expect(config.replyConfig.maxRepliesPerPr).toBe(10);
    expect(config.replyConfig.delaySeconds).toBe(5);
    expect(config.replyConfig.skipBots).toBe(false);
    expect(config.replyConfig.onlyCollaborators).toBe(false);
    expect(config.replyConfig.requireMention).toBe(false);
  });

  it('should fail when reply env vars are invalid', () => {
    expect(() => loadRuntimeConfig({ ...validEnv, REPLY_ENABLED: 'maybe' })).toThrow(
      'REPLY_ENABLED must be true or false',
    );

    expect(() => loadRuntimeConfig({ ...validEnv, REPLY_MAX_PER_PR: '0' })).toThrow(
      'REPLY_MAX_PER_PR must be an integer between 1 and 100',
    );
  });
});
