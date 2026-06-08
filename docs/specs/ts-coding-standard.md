# Spec: ts-coding-standard

Scope: repo

# TypeScript Coding Standard

Scope: repo

## Naming Conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Variable | camelCase | `pullRequestNumber`, `isActive` |
| Function | camelCase | `fetchDiff()`, `postReview()` |
| Class | PascalCase | `GitHubClient`, `ReviewOrchestrator` |
| Interface | PascalCase (no `I` prefix) | `ReviewComment`, `PullRequestPayload` |
| Type alias | PascalCase | `Severity`, `EventAction` |
| Enum | PascalCase (members: PascalCase) | `enum Severity { Warning, Error }` |
| Constant | UPPER_SNAKE_CASE | `MAX_COMMENTS`, `DEFAULT_PORT` |
| Boolean variable | Prefix: `is`, `has`, `should` | `isDraft`, `hasConflict`, `shouldSkip` |
| Private member | Prefix: `_` (optional) | `_cache`, `_client` |
| File name | kebab-case | `github-client.ts`, `diff-parser.ts` |
| Directory | kebab-case | `src/webhook-handler/`, `src/ai-client/` |

## Core Principles

1. **DRY (Don't Repeat Yourself)** — extract shared logic into reusable functions/utilities
2. **Single Responsibility** — one module, one job
3. **Explicit > Implicit** — prefer named exports, explicit types, clear function signatures
4. **Fail fast** — validate inputs early, throw meaningful errors

## TypeScript Rules

- **Strict mode**: `"strict": true` in tsconfig
- **No `any`**: use `unknown` + type guards instead
- **Return types**: always declare on public functions
- **Type inference**: let TS infer for local variables, explicit for exports
- **Enums vs Union Types**: prefer union types (`type Foo = "a" | "b"`) for simple cases, enums for grouped constants
- **Null handling**: use optional chaining `?.` and nullish coalescing `??`
- **Async**: always use `async/await`, avoid raw `.then()` chains

## Error Handling

- Custom error classes extending `Error` with `name`, `message`, `code`
- Always catch specific errors, avoid bare `catch (e)`
- Log error context (request ID, repo, PR number) before re-throwing

## Code Style

- **Formatter**: Prettier (default config)
- **Linter**: ESLint with `@typescript-eslint/recommended`
- **Imports**: group order — node builtins → external → internal → relative
- **No default exports**: use named exports only
- **Line length**: 100 chars max
- **Quotes**: single quotes for strings
- **Semicolons**: always

## File Structure

```
src/
  feature-name/
    index.ts          ← public API (re-export)
    feature-name.ts   ← main logic
    types.ts          ← types/interfaces
    utils.ts          ← helpers (if needed)
```

## Suggested Additions

- **Zod for runtime validation** — validate webhook payloads and AI responses with schemas
- **Barrel exports** — each folder has `index.ts` that re-ports public API
- **Dependency injection** — pass clients (Octokit, fetch) via constructor, not globals
- **Unit-testable design** — pure functions where possible, inject I/O dependencies