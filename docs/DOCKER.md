# Docker

## Image

Build the production image from the repository root:

```bash
docker build -t aperio-agent:latest .
```

Run the app container:

```bash
docker run --rm \
  --env-file .env.production \
  -p 3000:3000 \
  aperio-agent:latest
```

The production image runs `bun run dist/index.js`. It reads environment variables from the container environment.

The command above starts only the app container. Set `REDIS_URL` to a Redis endpoint reachable from that container.

## Docker Compose development

Start the development stack:

```bash
docker compose up --build
```

The development Compose file builds the `development` target, mounts the repository into `/app`, and runs `bun run src/index.ts`.

The development service loads `.env` and maps `${HOST_PORT:-3000}:3000`. Set `REDIS_URL` in `.env` to the Redis endpoint.

Start development with the local Redis service:

```bash
docker compose --profile redis up --build
```

When using the local Redis profile, set `REDIS_URL=redis://redis:6379` in `.env`.

Stop the development stack:

```bash
docker compose down
```

## Docker Compose production

Build the local production image:

```bash
docker build -t aperio-agent:latest .
```

Start the production stack:

```bash
docker compose -f docker-compose.prod.yml up -d
```

Use a registry image by setting `APERIO_IMAGE`:

```bash
APERIO_IMAGE=ghcr.io/owner/aperio-agent:tag docker compose -f docker-compose.prod.yml up -d
```

The production Compose file starts the app image and maps `${HOST_PORT:-3000}:3000`.

The production service loads environment variables from `${APERIO_ENV_FILE:-.env.production}`.

Start production with the local Redis service:

```bash
docker compose -f docker-compose.prod.yml --profile redis up -d
```

When using the local Redis profile, set `REDIS_URL=redis://redis:6379` in the selected env file.

View app logs:

```bash
docker compose -f docker-compose.prod.yml logs -f app
```

Stop the production stack:

```bash
docker compose -f docker-compose.prod.yml down
```

## Environment variables

Required:

- `GITHUB_APP_ID`
- `GITHUB_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`
- `AI_BASE_URL`
- `AI_API_KEY`
- `AI_MODEL`

Common optional values:

- `HOST_PORT`: Compose host port, defaults to `3000`
- `PORT`: app port for non-Compose containers, defaults to `3000`
- `REDIS_URL`: defaults to `redis://localhost:6379`
- `LOG_LEVEL`: defaults to `info`
- `MAX_COMMENTS`: defaults to `10`
- `WEBHOOK_MAX_BODY_BYTES`: defaults to `5000000`
- `AI_REQUEST_TIMEOUT_MS`: defaults to `60000`
- `GITHUB_REQUEST_TIMEOUT_MS`: defaults to `20000`
- `SKIP_PATTERNS`: comma-separated minimatch patterns for files to skip
- `REPLY_REQUIRE_MENTION`: defaults to `true`

The container exposes `GET /health` and `GET /ready` on port `3000`. Docker health checks use `GET /ready`.
