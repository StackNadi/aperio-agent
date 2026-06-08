import { beforeEach, describe, expect, it, mock } from 'bun:test';
import pino from 'pino';
import { AiClient } from '../../src/ai-client/index';

const logger = pino({ level: 'silent' });

const mockFetch = (response: string, status = 200) => {
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(response, { status })),
  ) as unknown as typeof fetch;
};

describe('AiClient', () => {
  let aiClient: AiClient;

  beforeEach(() => {
    aiClient = new AiClient(
      {
        baseUrl: 'https://api.example.com',
        apiKey: 'test-key',
        model: 'test-model',
        temperature: 0.2,
      },
      logger,
    );
  });

  describe('reviewDiff', () => {
    it('should parse valid JSON response', async () => {
      const response = JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify([
                {
                  file: 'src/index.ts',
                  line: 42,
                  severity: 'warning',
                  comment: 'Missing error handling',
                },
              ]),
            },
          },
        ],
      });

      mockFetch(response);

      const result = await aiClient.reviewDiff('+const x = 1;', 'src/index.ts');

      expect(result).toHaveLength(1);
      expect(result[0]?.file).toBe('src/index.ts');
      expect(result[0]?.line).toBe(42);
      expect(result[0]?.severity).toBe('warning');
      expect(result[0]?.comment).toBe('Missing error handling');
    });

    it('should handle markdown-wrapped JSON response', async () => {
      const response = JSON.stringify({
        choices: [
          {
            message: {
              content: `\`\`\`json\n${JSON.stringify([
                {
                  file: 'test.ts',
                  line: 10,
                  severity: 'critical',
                  comment: 'Bug found',
                },
              ])}\n\`\`\``,
            },
          },
        ],
      });

      mockFetch(response);

      const result = await aiClient.reviewDiff('+const x = 1;', 'test.ts');

      expect(result).toHaveLength(1);
      expect(result[0]?.severity).toBe('critical');
    });

    it('should return empty array for empty response', async () => {
      const response = JSON.stringify({
        choices: [
          {
            message: {
              content: '[]',
            },
          },
        ],
      });

      mockFetch(response);

      const result = await aiClient.reviewDiff('+const x = 1;', 'test.ts');
      expect(result).toHaveLength(0);
    });

    it('should throw on API error', async () => {
      mockFetch('Internal Server Error', 500);

      await expect(aiClient.reviewDiff('+const x = 1;', 'test.ts')).rejects.toThrow();
    });

    it('should retry transient API errors', async () => {
      let callCount = 0;
      const successfulResponse = JSON.stringify({
        choices: [
          {
            message: {
              content: '[]',
            },
          },
        ],
      });

      globalThis.fetch = mock(() => {
        callCount++;

        if (callCount === 1) {
          return Promise.resolve(new Response('Rate limited', { status: 429 }));
        }

        return Promise.resolve(new Response(successfulResponse, { status: 200 }));
      }) as unknown as typeof fetch;

      const result = await aiClient.reviewDiff('+const x = 1;', 'test.ts');

      expect(result).toHaveLength(0);
      expect(callCount).toBe(2);
    });

    it('should retry network errors', async () => {
      let callCount = 0;
      const successfulResponse = JSON.stringify({
        choices: [
          {
            message: {
              content: '[]',
            },
          },
        ],
      });

      globalThis.fetch = mock(() => {
        callCount++;

        if (callCount === 1) {
          return Promise.reject(new Error('Network unavailable'));
        }

        return Promise.resolve(new Response(successfulResponse, { status: 200 }));
      }) as unknown as typeof fetch;

      const result = await aiClient.reviewDiff('+const x = 1;', 'test.ts');

      expect(result).toHaveLength(0);
      expect(callCount).toBe(2);
    });

    it('should not retry malformed API response JSON', async () => {
      let callCount = 0;

      globalThis.fetch = mock(() => {
        callCount++;
        return Promise.resolve(new Response('not api json', { status: 200 }));
      }) as unknown as typeof fetch;

      await expect(aiClient.reviewDiff('+const x = 1;', 'test.ts')).rejects.toThrow();
      expect(callCount).toBe(1);
    });

    it('should pass a timeout signal to fetch', async () => {
      const response = JSON.stringify({ choices: [{ message: { content: '[]' } }] });
      let hasSignal = false;

      globalThis.fetch = mock((_url, init) => {
        hasSignal = Boolean((init as RequestInit).signal);
        return Promise.resolve(new Response(response, { status: 200 }));
      }) as unknown as typeof fetch;

      await aiClient.reviewDiff('+const x = 1;', 'test.ts');

      expect(hasSignal).toBe(true);
    });

    it('should throw on invalid JSON response', async () => {
      const response = JSON.stringify({
        choices: [
          {
            message: {
              content: 'not valid json',
            },
          },
        ],
      });

      mockFetch(response);

      await expect(aiClient.reviewDiff('+const x = 1;', 'test.ts')).rejects.toThrow();
    });

    it('should throw on missing content in response', async () => {
      const response = JSON.stringify({
        choices: [
          {
            message: {},
          },
        ],
      });

      mockFetch(response);

      await expect(aiClient.reviewDiff('+const x = 1;', 'test.ts')).rejects.toThrow();
    });
  });
});
