# aperio-agent

GitHub App that reviews pull requests with an OpenAI-compatible AI provider.

Install dependencies:

```bash
bun install
```

Run locally:

```bash
bun dev
```

Build the production bundle:

```bash
bun run build
```

Run checks:

```bash
bun run check
bun run typecheck
bun test
```

## Production notes

Aperio runs as a self-hosted GitHub App. It needs repository-scoped GitHub App credentials, Redis, and an OpenAI-compatible AI provider.

Aperio expects models with at least `128k` context for normal PR reviews. Set `AI_CONTEXT_WINDOW_TOKENS` to your model's context window. Aperio keeps room for prompts and output, then skips file diffs that do not fit the input budget.

PR diffs go to the configured AI provider. For private repositories, check the provider's retention, training, and logging settings before enabling the app.

Setup docs are in [`docs/GUIDE.md`](./docs/GUIDE.md). Docker docs are in [`docs/DOCKER.md`](./docs/DOCKER.md).
