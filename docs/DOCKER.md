# Docker

## Pre-built image

```bash
docker pull ghcr.io/StackNadi/aperio-agent:latest
```

Available tags: `latest`, `1.0.0`, `1.0`

## Build locally

Build the production image from the repository root:

```bash
docker build -t aperio-agent:latest .
```

Run the container:

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
APERIO_IMAGE=ghcr.io/StackNadi/aperio-agent:latest docker compose -f docker-compose.prod.yml up -d
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

## Configuration

Copy `.env.example` to `.env.production` and fill in the required values. All available variables and their defaults are documented in that file.

```bash
cp .env.example .env.production
```

The container exposes `GET /health` and `GET /ready` on port `3000`. Docker health checks use `GET /ready`.
