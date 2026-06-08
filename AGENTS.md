# AGENTS.md - Aperio-agent

## Project Overview

### Tech Stack

- Language: TypeScript
- Package Manager: Bun (always use Bun, never npm)
- Bun Version: v1.3.x (required)

## Key Commands

- Install: `bun install`
- Dev server: `bun dev`
- Build: `bun run build`
- Lint: `bun lint`
- Test all: `bun test`
- Test single file: `bun test src/path/to/file.test.ts`

## Project Structure

- `src/` - application source code
- `src/index.ts` - main entry point (Bun.serve HTTP server)
- `src/webhook-handler/` - GitHub webhook endpoint + signature verification
- `src/github-client/` - Octokit JWT auth, fetch files, post reviews
- `src/ai-client/` - OpenAI-compatible LLM client with Zod validation
- `src/review-orchestrator/` - BullMQ worker, chunking, AI pipeline
- `src/diff-parser/` - unified diff parsing, line extraction
- `src/utils/` - shared utilities, Redis client, types
- `docs/plans/` - implementation plans
- `docs/specs/` - feature and coding specifications
- `tests/` - test files (mirror src/ structure)

## Code Style

See full standards in `docs/specs/ts-coding-standard.md`
and `docs/specs/comment-standard.md`. Key conventions:

```ts
const pullRequestNumber = 42;
const MAX_COMMENTS = 10;
const isDraft = true;
class GitHubClient {}
interface ReviewComment {}
```

- Inline comments `//` are prohibited, please use
[TSDoc](https://tsdoc.org) `/** */` only
- Public functions, classes, interfaces must have [TSDoc](https://tsdoc.org)
- camelCase for variables, UPPER_SNAKE_CASE for constants
- Boolean prefix: is, has, should
- PascalCase for classes and interfaces, no I prefix

## Non-Obvious Patterns

- Runtime is Bun, not Node
  Use Bun native APIs:
  `Bun.serve()` not `http.createServer()`,
  `Bun.file()` not `fs.readFile()`,
  `Bun.write()` not `fs.writeFile()`

- Do not install or import `dotenv`
  bun already injects env vars at runtime, access `process.env.VAR_NAME` directly

## Testing Rules

- Write tests for all new functionality
- Tests must be deterministic and isolated
- Mock all external dependencies
- Run `bun test` before marking any task complete

## Boundaries

### ✅ Allowed without asking

- Read files, list directory contents
- Run lint, single test files

### ⚠️ Ask first

- Install or remove packages
- Delete files
- Commit files or changes
- Push to git or open PRs

### 🚫 Never

- Commit secrets, `.env` files, or credentials
- Force push to main or protected branches
- Modify `AGENTS.md`

## Key Files

- `src/index.ts` - application entry point
- `src/review-orchestrator/index.ts` - BullMQ worker, chunking pipeline,
AI -> GitHub flow
- `docs/specs/ts-coding-standard.md` - naming conventions, TypeScript rules
- `docs/specs/review-bot-spec.md` - feature spec, API contracts, error handling
