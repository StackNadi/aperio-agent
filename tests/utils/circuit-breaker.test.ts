import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import pino from 'pino';
import { createCircuitBreaker } from '../../src/utils/circuit-breaker';

const logger = pino({ level: 'silent' });

describe('CircuitBreaker', () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = {
      CIRCUIT_BREAKER_THRESHOLD: process.env.CIRCUIT_BREAKER_THRESHOLD,
      CIRCUIT_BREAKER_RESET_MS: process.env.CIRCUIT_BREAKER_RESET_MS,
      CIRCUIT_BREAKER_VOLUME: process.env.CIRCUIT_BREAKER_VOLUME,
    };
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

  it('should start in closed state', () => {
    const breaker = createCircuitBreaker(async () => 'ok', 'test', logger);

    expect(breaker.closed).toBe(true);
    expect(breaker.opened).toBe(false);
    expect(breaker.halfOpen).toBe(false);

    breaker.shutdown();
  });

  it('should execute function successfully when closed', async () => {
    const fn = async (x: number) => x * 2;
    const breaker = createCircuitBreaker(fn, 'test', logger);

    const result = await breaker.fire(5);
    expect(result).toBe(10);

    breaker.shutdown();
  });

  it('should open after threshold failures', async () => {
    process.env.CIRCUIT_BREAKER_VOLUME = '2';
    process.env.CIRCUIT_BREAKER_THRESHOLD = '50';

    const fn = async () => {
      throw new Error('fail');
    };

    const breaker = createCircuitBreaker(fn, 'test', logger);

    await breaker.fire().catch(() => {});
    expect(breaker.closed).toBe(true);

    await breaker.fire().catch(() => {});
    expect(breaker.opened).toBe(true);

    breaker.shutdown();
  });

  it('should reject requests when open', async () => {
    process.env.CIRCUIT_BREAKER_VOLUME = '1';
    process.env.CIRCUIT_BREAKER_THRESHOLD = '50';

    const fn = async () => {
      throw new Error('fail');
    };

    const breaker = createCircuitBreaker(fn, 'test', logger);

    await breaker.fire().catch(() => {});
    expect(breaker.opened).toBe(true);

    await expect(breaker.fire()).rejects.toThrow();
    expect(breaker.opened).toBe(true);

    breaker.shutdown();
  });

  it('should transition to half-open after reset timeout', async () => {
    process.env.CIRCUIT_BREAKER_VOLUME = '1';
    process.env.CIRCUIT_BREAKER_THRESHOLD = '50';
    process.env.CIRCUIT_BREAKER_RESET_MS = '100';

    const fn = async () => {
      throw new Error('fail');
    };

    const breaker = createCircuitBreaker(fn, 'test', logger);

    await breaker.fire().catch(() => {});
    expect(breaker.opened).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 150));

    const halfOpenPromise = new Promise<void>((resolve) => {
      breaker.on('halfOpen', () => {
        resolve();
      });
    });

    await breaker.fire().catch(() => {});
    await halfOpenPromise;

    breaker.shutdown();
  });

  it('should close after successful half-open probe', async () => {
    process.env.CIRCUIT_BREAKER_VOLUME = '1';
    process.env.CIRCUIT_BREAKER_THRESHOLD = '50';
    process.env.CIRCUIT_BREAKER_RESET_MS = '100';

    let shouldFail = true;
    const fn = async () => {
      if (shouldFail) throw new Error('fail');
      return 'ok';
    };

    const breaker = createCircuitBreaker(fn, 'test', logger);

    await breaker.fire().catch(() => {});
    expect(breaker.opened).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 150));

    shouldFail = false;
    await breaker.fire();
    expect(breaker.closed).toBe(true);

    breaker.shutdown();
  });

  it('should re-open if half-open probe fails', async () => {
    process.env.CIRCUIT_BREAKER_VOLUME = '1';
    process.env.CIRCUIT_BREAKER_THRESHOLD = '50';
    process.env.CIRCUIT_BREAKER_RESET_MS = '100';

    const fn = async () => {
      throw new Error('fail');
    };

    const breaker = createCircuitBreaker(fn, 'test', logger);

    await breaker.fire().catch(() => {});
    expect(breaker.opened).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 150));

    await breaker.fire().catch(() => {});
    expect(breaker.opened).toBe(true);

    breaker.shutdown();
  });

  it('should use custom configuration from env vars', async () => {
    process.env.CIRCUIT_BREAKER_VOLUME = '2';
    process.env.CIRCUIT_BREAKER_THRESHOLD = '50';
    process.env.CIRCUIT_BREAKER_RESET_MS = '5000';

    const fn = async () => 'ok';
    const breaker = createCircuitBreaker(fn, 'test', logger);

    expect(breaker.volumeThreshold).toBe(2);

    const result = await breaker.fire();
    expect(result).toBe('ok');

    breaker.shutdown();
  });
});
