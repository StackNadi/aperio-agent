import { minimatch } from 'minimatch';

/**
 * Parsed diff containing all hunks for a single file.
 */
export interface DiffHunk {
  /** File path relative to repository root */
  filePath: string;
  /** Array of diff hunks in this file */
  hunks: Hunk[];
}

/**
 * A single diff hunk with its header info and content.
 */
export interface Hunk {
  /** Starting line in the old file */
  oldStart: number;
  /** Number of lines in the old file */
  oldLines: number;
  /** Starting line in the new file */
  newStart: number;
  /** Number of lines in the new file */
  newLines: number;
  /** Raw hunk content (context + added + removed lines) */
  content: string;
  /** Lines added in this hunk with their new file line numbers */
  addedLines: AddedLine[];
}

/**
 * A single added line with its position in the new file.
 */
export interface AddedLine {
  /** Line number in the new file */
  lineNumber: number;
  /** Content of the added line (without the `+` prefix) */
  content: string;
}

/**
 * A single line from a diff with its type and position.
 */
export interface DiffLine {
  /** Whether the line was added, removed, or is context */
  type: 'added' | 'removed' | 'context';
  /** Raw line content */
  content: string;
  /** Line number in the old file (undefined for added lines) */
  oldLineNumber?: number;
  /** Line number in the new file (undefined for removed lines) */
  newLineNumber?: number;
}

/**
 * Default glob patterns that should be skipped during review.
 */
const DEFAULT_SKIP_PATTERNS: string[] = [
  '*.lock',
  '*.lockb',
  '*.min.js',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.map',
  '*.d.ts',
  'node_modules/**',
  '**/node_modules/**',
  '.git/**',
  '**/.git/**',
  'dist/**',
  '**/dist/**',
  'build/**',
  '**/build/**',
];

/**
 * Binary file extensions that cannot be reviewed as text.
 */
const BINARY_EXTENSIONS: string[] = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.zip',
  '.tar',
  '.gz',
  '.pdf',
  '.doc',
  '.docx',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
];

/**
 * Checks if a file should be skipped based on its path matching skip patterns.
 *
 * @param filePath - File path to check
 * @returns `true` if file matches any skip pattern
 */
export function shouldSkipFile(filePath: string): boolean {
  return getSkipPatterns().some((pattern) =>
    minimatch(filePath, pattern, { dot: true, matchBase: true }),
  );
}

/**
 * Gets configured skip patterns from `SKIP_PATTERNS` or defaults.
 *
 * @returns Glob patterns used to skip files during review
 */
function getSkipPatterns(): string[] {
  const configuredPatterns = process.env.SKIP_PATTERNS?.split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0);

  return configuredPatterns && configuredPatterns.length > 0
    ? configuredPatterns
    : DEFAULT_SKIP_PATTERNS;
}

/**
 * Checks if a file is binary based on its extension.
 *
 * @param filePath - File path to check
 * @returns `true` if file has a binary extension
 */
export function isBinaryFile(filePath: string): boolean {
  const ext = filePath.toLowerCase().split('.').pop();
  return ext ? BINARY_EXTENSIONS.includes(`.${ext}`) : false;
}

/**
 * Parses a unified diff patch into structured hunks with added line tracking.
 *
 * Extracts hunk headers and tracks which lines were added (not removed or context).
 * Added lines are mapped to their new file line numbers for GitHub API submission.
 *
 * @param patch - Raw unified diff string from GitHub API
 * @param filePath - File path for the resulting DiffHunk
 * @returns Parsed diff with hunks and added lines
 */
export function parseDiff(patch: string, filePath: string): DiffHunk {
  const lines = patch.split('\n');
  const hunks: Hunk[] = [];
  let currentHunk: Hunk | null = null;
  let newLineCounter = 0;

  for (const line of lines) {
    const hunkMatch = line.match(/^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);

    if (hunkMatch) {
      if (currentHunk) {
        hunks.push(currentHunk);
      }

      currentHunk = {
        oldStart: Number.parseInt(hunkMatch[1] ?? '0', 10),
        oldLines: Number.parseInt(hunkMatch[2] || '1', 10),
        newStart: Number.parseInt(hunkMatch[3] ?? '0', 10),
        newLines: Number.parseInt(hunkMatch[4] || '1', 10),
        content: '',
        addedLines: [],
      };

      newLineCounter = Number.parseInt(hunkMatch[3] ?? '0', 10);
      continue;
    }

    if (!currentHunk) continue;

    currentHunk.content += `${line}\n`;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      currentHunk.addedLines.push({
        lineNumber: newLineCounter,
        content: line.substring(1),
      });
      newLineCounter++;
    } else if (!line.startsWith('-') || line.startsWith('---')) {
      newLineCounter++;
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return { filePath, hunks };
}

/**
 * Extracts all added lines from a parsed diff.
 *
 * @param diffHunk - Parsed diff result
 * @returns Flat array of all added lines across all hunks
 */
export function extractAddedLines(diffHunk: DiffHunk): AddedLine[] {
  return diffHunk.hunks.flatMap((hunk) => hunk.addedLines);
}

/**
 * Formats a parsed diff back into unified diff format for AI consumption.
 *
 * Adds explicit line numbers to added lines so the AI can reference them correctly.
 *
 * @param diffHunk - Parsed diff result
 * @returns Formatted diff string with line numbers
 */
export function formatDiffForAi(diffHunk: DiffHunk): string {
  return diffHunk.hunks
    .map((hunk) => {
      const header = `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
      const lines = hunk.content.split('\n');
      let lineNum = hunk.newStart;

      const numberedLines = lines.map((line) => {
        if (line.startsWith('+') && !line.startsWith('+++')) {
          const result = `[Line ${lineNum}] ${line}`;
          lineNum++;
          return result;
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          return line;
        } else {
          lineNum++;
          return line;
        }
      });

      return `${header}\n${numberedLines.join('\n')}`;
    })
    .join('\n');
}
