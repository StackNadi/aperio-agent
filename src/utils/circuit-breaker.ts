import CircuitBreaker from 'opossum';
import type { Logger } from 'pino';

/** Default error percentage threshold to open the circuit */
const DEFAULT_ERROR_THRESHOLD_PERCENTAGE = 50;

/** Default cooldown in ms before attempting half-open */
const DEFAULT_RESET_TIMEOUT_MS = 30_000;

/** Default minimum requests before circuit can open */
const DEFAULT_VOLUME_THRESHOLD = 5;

/**
 * Creates a circuit breaker that wraps an async function.
 *
 * Reads configuration from environment variables:
 * - `CIRCUIT_BREAKER_THRESHOLD` — error % to open (default: 50)
 * - `CIRCUIT_BREAKER_RESET_MS` — cooldown before half-open (default: 30000)
 * - `CIRCUIT_BREAKER_VOLUME` — min requests before opening (default: 5)
 *
 * @param fn - The async function to protect
 * @param name - Circuit name for logging and monitoring
 * @param logger - Pino logger instance
 * @returns Configured CircuitBreaker instance
 *
 * @example
 * ```typescript
 * const breaker = createCircuitBreaker(callApi, 'ai-api', logger);
 * const result = await breaker.fire(prompt);
 * ```
 */
export function createCircuitBreaker<TI extends unknown[], TR>(
  fn: (...args: TI) => Promise<TR>,
  name: string,
  logger: Logger,
): CircuitBreaker<TI, TR> {
  const errorThresholdPercentage =
    Number(process.env.CIRCUIT_BREAKER_THRESHOLD) || DEFAULT_ERROR_THRESHOLD_PERCENTAGE;
  const resetTimeout = Number(process.env.CIRCUIT_BREAKER_RESET_MS) || DEFAULT_RESET_TIMEOUT_MS;
  const volumeThreshold = Number(process.env.CIRCUIT_BREAKER_VOLUME) || DEFAULT_VOLUME_THRESHOLD;

  const breaker = new CircuitBreaker(fn, {
    timeout: false,
    errorThresholdPercentage,
    resetTimeout,
    volumeThreshold,
    name,
  });

  breaker.on('open', () => {
    logger.warn({ name, errorThresholdPercentage, resetTimeout }, 'Circuit opened');
  });

  breaker.on('halfOpen', () => {
    logger.info({ name }, 'Circuit half-open, testing recovery');
  });

  breaker.on('close', () => {
    logger.info({ name }, 'Circuit closed, service recovered');
  });

  breaker.on('reject', () => {
    logger.warn({ name }, 'Circuit rejected request (circuit is open)');
  });

  return breaker;
}
