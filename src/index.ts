import { serve } from 'bun';
import pino from 'pino';
import { loadRuntimeConfig } from './config/index';
import { createReviewWorker } from './review-orchestrator/index';
import { closeRedis, closeReviewQueue, healthHandler, readinessHandler } from './utils/index';
import { webhookHandler } from './webhook-handler/index';

const SHUTDOWN_TIMEOUT_MS = 10_000;

const runtimeConfig = loadRuntimeConfig();

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true },
  },
});

/** BullMQ worker that processes PR review jobs asynchronously */
const worker = createReviewWorker(logger, runtimeConfig);
logger.info('Review worker initialized');

const port = runtimeConfig.port;

/**
 * Main HTTP server using Bun's built-in `serve()`.
 *
 * Routes:
 * - `GET /health` → health check endpoint
 * - `GET /ready` → readiness check endpoint
 * - `POST /webhook` → GitHub webhook handler
 * - All other routes → 404
 */
const server = serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;

    logger.info({ method, path: url.pathname }, 'Incoming request');

    if (method === 'GET' && url.pathname === '/health') {
      return healthHandler();
    }

    if (method === 'GET' && url.pathname === '/ready') {
      return await readinessHandler();
    }

    if (method === 'POST' && url.pathname === '/webhook') {
      return webhookHandler(req, logger, {
        webhookSecret: runtimeConfig.githubWebhookSecret,
        maxBodyBytes: runtimeConfig.webhookMaxBodyBytes,
      });
    }

    return new Response('Not Found', { status: 404 });
  },
});

logger.info({ port: server.port }, 'PR Review Bot server started');

let isShuttingDown = false;

/**
 * Performs a graceful shutdown of the application.
 *
 * Sequence:
 * 1. Stop accepting new HTTP connections
 * 2. Close BullMQ worker (waits for active jobs)
 * 3. Close BullMQ queue
 * 4. Close Redis connection
 *
 * Forces exit after SHUTDOWN_TIMEOUT_MS if graceful shutdown hangs.
 */
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    logger.warn({ signal }, 'Shutdown already in progress, ignoring signal');
    return;
  }
  isShuttingDown = true;

  logger.info({ signal }, 'Graceful shutdown initiated');

  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref();

  try {
    server.stop(true);
    logger.info('HTTP server stopped');

    await worker.close();
    logger.info('BullMQ worker closed');

    await closeReviewQueue();
    logger.info('BullMQ queue closed');

    await closeRedis();
    logger.info('Redis connection closed');

    logger.info('Graceful shutdown complete');
  } catch (error) {
    logger.error({ error }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
