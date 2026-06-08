import { describe, expect, it } from 'bun:test';
import {
  extractAddedLines,
  formatDiffForAi,
  isBinaryFile,
  parseDiff,
  shouldSkipFile,
} from '../../src/diff-parser/index';

describe('shouldSkipFile', () => {
  it('should skip lock files', () => {
    expect(shouldSkipFile('package-lock.json')).toBe(true);
    expect(shouldSkipFile('yarn.lock')).toBe(true);
    expect(shouldSkipFile('pnpm-lock.yaml')).toBe(true);
    expect(shouldSkipFile('bun.lockb')).toBe(true);
  });

  it('should skip minified files', () => {
    expect(shouldSkipFile('bundle.min.js')).toBe(true);
  });

  it('should skip map files', () => {
    expect(shouldSkipFile('bundle.js.map')).toBe(true);
  });

  it('should skip declaration files', () => {
    expect(shouldSkipFile('types.d.ts')).toBe(true);
  });

  it('should skip node_modules', () => {
    expect(shouldSkipFile('node_modules/package/index.js')).toBe(true);
  });

  it('should skip dist and build directories', () => {
    expect(shouldSkipFile('dist/index.js')).toBe(true);
    expect(shouldSkipFile('build/output.js')).toBe(true);
  });

  it('should not skip normal files', () => {
    expect(shouldSkipFile('src/index.ts')).toBe(false);
    expect(shouldSkipFile('README.md')).toBe(false);
    expect(shouldSkipFile('package.json')).toBe(false);
  });

  it('should use SKIP_PATTERNS environment globs when configured', () => {
    const previousSkipPatterns = process.env.SKIP_PATTERNS;
    process.env.SKIP_PATTERNS = 'docs/**,*.generated.ts';

    try {
      expect(shouldSkipFile('docs/usage.md')).toBe(true);
      expect(shouldSkipFile('src/client.generated.ts')).toBe(true);
      expect(shouldSkipFile('package-lock.json')).toBe(false);
    } finally {
      if (previousSkipPatterns === undefined) {
        delete process.env.SKIP_PATTERNS;
      } else {
        process.env.SKIP_PATTERNS = previousSkipPatterns;
      }
    }
  });
});

describe('isBinaryFile', () => {
  it('should detect image files', () => {
    expect(isBinaryFile('image.png')).toBe(true);
    expect(isBinaryFile('photo.jpg')).toBe(true);
    expect(isBinaryFile('icon.svg')).toBe(true);
  });

  it('should detect archive files', () => {
    expect(isBinaryFile('archive.zip')).toBe(true);
    expect(isBinaryFile('backup.tar.gz')).toBe(true);
  });

  it('should detect font files', () => {
    expect(isBinaryFile('font.woff')).toBe(true);
    expect(isBinaryFile('font.woff2')).toBe(true);
  });

  it('should not detect text files', () => {
    expect(isBinaryFile('index.ts')).toBe(false);
    expect(isBinaryFile('README.md')).toBe(false);
    expect(isBinaryFile('style.css')).toBe(false);
  });
});

describe('parseDiff', () => {
  it('should parse a simple diff with added lines', () => {
    const patch = `@@ -0,0 +1,5 @@
+import { serve } from 'bun';
+import pino from 'pino';
+
+const port = 3000;
+serve({ port });`;

    const result = parseDiff(patch, 'src/index.ts');

    expect(result.filePath).toBe('src/index.ts');
    expect(result.hunks).toHaveLength(1);
    expect(result.hunks[0]?.newStart).toBe(1);
    expect(result.hunks[0]?.addedLines).toHaveLength(5);
  });

  it('should track correct line numbers for added lines', () => {
    const patch = `@@ -1,3 +1,5 @@
 context line
+added line 1
+added line 2
 another context`;

    const result = parseDiff(patch, 'test.ts');
    const addedLines = result.hunks[0]?.addedLines ?? [];

    expect(addedLines).toHaveLength(2);
    expect(addedLines[0]?.lineNumber).toBe(2);
    expect(addedLines[0]?.content).toBe('added line 1');
    expect(addedLines[1]?.lineNumber).toBe(3);
    expect(addedLines[1]?.content).toBe('added line 2');
  });

  it('should handle multiple hunks', () => {
    const patch = `@@ -1,3 +1,4 @@
 line1
+new line
 line2
 line3
@@ -10,3 +11,4 @@
 line10
+another new line
 line11
 line12`;

    const result = parseDiff(patch, 'test.ts');

    expect(result.hunks).toHaveLength(2);
    expect(result.hunks[0]?.addedLines).toHaveLength(1);
    expect(result.hunks[1]?.addedLines).toHaveLength(1);
  });

  it('should skip file headers (+++ b/file)', () => {
    const patch = `@@ -1,2 +1,3 @@
+import { serve } from 'bun';
 context
+const port = 3000;`;

    const result = parseDiff(patch, 'test.ts');
    expect(result.hunks[0]?.addedLines).toHaveLength(2);
  });
});

describe('extractAddedLines', () => {
  it('should extract all added lines from all hunks', () => {
    const diffHunk = {
      filePath: 'test.ts',
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 4,
          content: '',
          addedLines: [
            { lineNumber: 1, content: 'line1' },
            { lineNumber: 2, content: 'line2' },
          ],
        },
        {
          oldStart: 10,
          oldLines: 2,
          newStart: 12,
          newLines: 3,
          content: '',
          addedLines: [{ lineNumber: 13, content: 'line3' }],
        },
      ],
    };

    const result = extractAddedLines(diffHunk);
    expect(result).toHaveLength(3);
    expect(result[0]?.lineNumber).toBe(1);
    expect(result[1]?.lineNumber).toBe(2);
    expect(result[2]?.lineNumber).toBe(13);
  });

  it('should return empty array for no added lines', () => {
    const diffHunk = {
      filePath: 'test.ts',
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 2,
          content: '',
          addedLines: [],
        },
      ],
    };

    const result = extractAddedLines(diffHunk);
    expect(result).toHaveLength(0);
  });
});

describe('formatDiffForAi', () => {
  it('should format diff with hunk headers', () => {
    const diffHunk = {
      filePath: 'test.ts',
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 4,
          content: ' context\n+added\n more context\n',
          addedLines: [{ lineNumber: 2, content: 'added' }],
        },
      ],
    };

    const result = formatDiffForAi(diffHunk);

    expect(result).toContain('@@ -1,2 +1,4 @@');
    expect(result).toContain(' context');
    expect(result).toContain('+added');
  });

  it('should join multiple hunks with newline', () => {
    const diffHunk = {
      filePath: 'test.ts',
      hunks: [
        {
          oldStart: 1,
          oldLines: 2,
          newStart: 1,
          newLines: 3,
          content: '+line1\n',
          addedLines: [{ lineNumber: 1, content: 'line1' }],
        },
        {
          oldStart: 10,
          oldLines: 2,
          newStart: 11,
          newLines: 3,
          content: '+line2\n',
          addedLines: [{ lineNumber: 12, content: 'line2' }],
        },
      ],
    };

    const result = formatDiffForAi(diffHunk);

    expect(result).toContain('@@ -1,2 +1,3 @@');
    expect(result).toContain('@@ -10,2 +11,3 @@');
    expect(result.split('\n').length).toBeGreaterThan(2);
  });
});
