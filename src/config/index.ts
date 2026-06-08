/**
 * Runtime configuration validated at process startup.
 */
export interface RuntimeConfig {
  /** GitHub App ID from GitHub Developer Settings */
  githubAppId: string;
  /** Decoded GitHub App private key PEM */
  githubPrivateKey: string;
  /** GitHub webhook secret */
  githubWebhookSecret: string;
  /** OpenAI-compatible API base URL */
  aiBaseUrl: string;
  /** API key for the AI provider */
  aiApiKey: string;
  /** AI model identifier */
  aiModel: string;
  /** Redis connection URL */
  redisUrl: string;
  /** HTTP server port */
  port: number;
  /** Maximum review comments posted per PR */
  maxComments: number;
  /** Maximum accepted webhook body size in bytes */
  webhookMaxBodyBytes: number;
  /** AI request timeout in milliseconds */
  aiRequestTimeoutMs: number;
  /** GitHub API request timeout in milliseconds */
  githubRequestTimeoutMs: number;
}

const DEFAULT_REDIS_URL = 'redis://localhost:6379';
const DEFAULT_PORT = 3000;
const DEFAULT_MAX_COMMENTS = 10;
const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 5_000_000;
const DEFAULT_AI_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 20_000;

type EnvSource = Record<string, string | undefined>;

/**
 * Loads and validates runtime configuration from environment variables.
 *
 * @param env - Environment source, defaults to `process.env`
 * @returns Validated runtime configuration
 * @throws {Error} If a required value is missing or malformed
 */
export function loadRuntimeConfig(env: EnvSource = process.env): RuntimeConfig {
  return {
    githubAppId: parseGitHubAppId(env),
    githubPrivateKey: decodePrivateKey(requireEnv(env, 'GITHUB_PRIVATE_KEY')),
    githubWebhookSecret: requireEnv(env, 'GITHUB_WEBHOOK_SECRET'),
    aiBaseUrl: parseUrlEnv(requireEnv(env, 'AI_BASE_URL'), 'AI_BASE_URL', ['http:', 'https:']),
    aiApiKey: requireEnv(env, 'AI_API_KEY'),
    aiModel: requireEnv(env, 'AI_MODEL'),
    redisUrl: parseUrlEnv(env.REDIS_URL ?? DEFAULT_REDIS_URL, 'REDIS_URL', ['redis:', 'rediss:']),
    port: parseIntegerEnv(env, 'PORT', DEFAULT_PORT, 1, 65_535),
    maxComments: parseIntegerEnv(env, 'MAX_COMMENTS', DEFAULT_MAX_COMMENTS, 1, 100),
    webhookMaxBodyBytes: parseIntegerEnv(
      env,
      'WEBHOOK_MAX_BODY_BYTES',
      DEFAULT_WEBHOOK_MAX_BODY_BYTES,
      1_024,
      50_000_000,
    ),
    aiRequestTimeoutMs: parseIntegerEnv(
      env,
      'AI_REQUEST_TIMEOUT_MS',
      DEFAULT_AI_REQUEST_TIMEOUT_MS,
      1_000,
      300_000,
    ),
    githubRequestTimeoutMs: parseIntegerEnv(
      env,
      'GITHUB_REQUEST_TIMEOUT_MS',
      DEFAULT_GITHUB_REQUEST_TIMEOUT_MS,
      1_000,
      300_000,
    ),
  };
}

function requireEnv(env: EnvSource, name: string): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function parseGitHubAppId(env: EnvSource): string {
  const appId = requireEnv(env, 'GITHUB_APP_ID');
  const numericAppId = Number(appId);

  if (!Number.isInteger(numericAppId) || numericAppId <= 0) {
    throw new Error('GITHUB_APP_ID must be a positive integer');
  }

  return appId;
}

function decodePrivateKey(encodedPrivateKey: string): string {
  const decodedPrivateKey = Buffer.from(encodedPrivateKey, 'base64').toString('utf-8').trim();

  if (
    !decodedPrivateKey.includes('BEGIN') ||
    !decodedPrivateKey.includes('PRIVATE KEY') ||
    !decodedPrivateKey.includes('END')
  ) {
    throw new Error('GITHUB_PRIVATE_KEY must be a base64-encoded PEM private key');
  }

  return decodedPrivateKey;
}

function parseUrlEnv(value: string, name: string, allowedProtocols: string[]): string {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (!allowedProtocols.includes(parsedUrl.protocol)) {
    throw new Error(`${name} must use one of: ${allowedProtocols.join(', ')}`);
  }

  return value;
}

function parseIntegerEnv(
  env: EnvSource,
  name: string,
  defaultValue: number,
  minValue: number,
  maxValue: number,
): number {
  const rawValue = env[name];

  if (rawValue === undefined || rawValue.trim() === '') {
    return defaultValue;
  }

  const value = Number(rawValue);

  if (!Number.isInteger(value) || value < minValue || value > maxValue) {
    throw new Error(`${name} must be an integer between ${minValue} and ${maxValue}`);
  }

  return value;
}
