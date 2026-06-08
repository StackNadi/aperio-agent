# Spec: comment-standard

Scope: repo

# Comment Standard

Scope: repo

## Overview

All code documentation (variables, classes, functions, methods) **must** use [TSDoc](https://tsdoc.org/). Comments that do not add meaningful information are prohibited.

## TSDoc Rules

### Required Documentation

| Element | TSDoc Required | Example |
|---------|---------------|--------|
| Public function | ✅ Yes | `/** Fetches PR files from GitHub API. */` |
| Public class | ✅ Yes | `/** Client for interacting with GitHub API via Octokit. */` |
| Public method | ✅ Yes | `/** Posts a review comment on a specific line. */` |
| Interface | ✅ Yes | `/** Metadata extracted from a pull request webhook payload. */` |
| Type alias | ✅ Yes | `/** Severity level for review comments. */` |
| Enum | ✅ Yes | `/** Supported severity levels for code review. */` |
| Constant | ⚠️ If complex | `/** Maximum tokens per chunk before splitting. */` |
| Private method | ⚠️ If complex | Only if the logic is non-obvious |

### TSDoc Format

```typescript
/**
 * Fetches pull request files from GitHub API with pagination.
 *
 * @param prNumber - The pull request number
 * @param perPage - Number of results per page (default: 100)
 * @returns Array of file objects from the PR
 * @throws {GitHubApiError} When API request fails
 *
 * @example
 * ```typescript
 * const files = await client.fetchPullRequestFiles(123);
 * ```
 */
async function fetchPullRequestFiles(prNumber: number, perPage = 100): Promise<File[]> {
  // implementation
}
```

### Supported Tags

| Tag | Purpose | Example |
|-----|---------|---------|
| `@param` | Parameter description | `@param prNumber - PR number to fetch` |
| `@returns` | Return value description | `@returns Array of review comments` |
| `@throws` | Possible errors thrown | `@throws {ValidationError} If payload invalid` |
| `@example` | Usage example | See example above |
| `@defaultValue` | Default value | `@defaultValue 10` |
| `@see` | Documentation reference | `@see https://docs.github.com/rest/pulls` |
| `@deprecated` | Mark as deprecated | `@deprecated Use fetchFilesV2() instead` |
| `@internal` | Internal use only | `@internal Not part of public API` |

## Prohibited (Bad Comments)

### 1. Comments That Repeat the Code

```typescript
// ❌ BAD: repeats the function name
/** Fetches files. */
async function fetchFiles() {}

// ✅ GOOD: explains non-obvious behavior
/**
 * Fetches PR files with automatic pagination handling.
 * Retries up to 3 times on rate limit (429) responses.
 */
async function fetchFiles() {}
```

### 2. Uninformative Comments

```typescript
// ❌ BAD: obvious
/** The port number. */
const port = 3000;

// ❌ BAD: adds no new information
/** Sets the value. */
function setValue(v: unknown) {}

// ✅ GOOD: explains constraints or behavior
/** Server port. Must be between 1024 and 65535. */
const PORT = 3000;
```

### 3. Dead Comments

```typescript
// ❌ BAD: code removed but comment remains
// TODO: add validation
// const validate = true;

// ❌ BAD: commented-out code
// function oldMethod() {
//   return 'old';
// }
```

### 4. Comments That Should Be Variable/Function Names

```typescript
// ❌ BAD: comment could be a variable name
// Check if user is active
if (u.a) {}

// ✅ GOOD: use descriptive names
if (user.isActive) {}
```

## Inline Comments — PROHIBITED

**Inline comments (`//` and `/* */` next to code) are NOT allowed.**

All documentation must use TSDoc block comments (`/** ... */`) placed **above** the documented element. If code needs explanation, refactor it to be self-documenting or move the explanation to TSDoc.

```typescript
// ❌ PROHIBITED: inline comment
const linePosition = diffLine + 1; // GitHub API returns line position starting from 1

// ❌ PROHIBITED: inline comment
// Step 1: Parse hunk header
const hunk = parseHeader(line);

// ✅ CORRECT: TSDoc above, or refactor variable/function name
/** GitHub API uses 1-based line positions, diff parser uses 0-based */
const gitHubLinePosition = diffLine + 1;
```

## Enforcement

- ESLint rule `eslint-plugin-tsdoc` for TSDoc format validation
- Code review must check documentation before merge
- PRs without adequate documentation must be rejected
