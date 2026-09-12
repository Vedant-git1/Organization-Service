# Resolve Organization Service

The Organization Service owns Resolve organization and tenant identity data. It exposes public organization management APIs and authenticated internal lookup APIs for other services. Other services must not connect directly to this service's MySQL database.

## Responsibilities

- Organization identity and lifecycle state (`ACTIVE` or `SUSPENDED`)
- Slug uniqueness and profile validation
- Tenant-aware public access control
- Internal organization lookup by ID and slug
- Request correlation, structured logging, health checks, and idempotent creation

Kafka events, user/team/case data, RBAC storage, role management, permission management, and workflow behavior are outside this service.

## Technology

Node.js 20, TypeScript, Express, MySQL 8, Prisma, Zod, Redis 7, Pino, Vitest, Supertest, Docker, and npm.

## Repository structure

```text
src/
  config/              Environment validation
  middleware/          Request, auth, validation, and security middleware
  modules/organization Domain types, repository, service, controllers, routes
  infrastructure/     Prisma and Redis adapters
  security/            JWT, authorization, and internal-auth boundaries
  shared/              Errors and logging
  app.ts               Express application assembly
  server.ts            Runtime startup and shutdown
prisma/                MySQL schema and committed migrations
tests/                 Unit, API, security, resilience, and integration tests
docs/                  OpenAPI, ADR, and phase notes
```

## Prerequisites

- Node.js 20 or newer
- npm
- Docker Desktop with the Linux engine enabled for MySQL/Redis integration

## Local setup

```bash
cp .env.example .env
npm ci
npm run prisma:generate
docker compose up -d mysql redis
npm run prisma:deploy
npm run dev
```

The service listens on `http://localhost:3000`. Local MySQL is published on port `3307`; Redis is published on port `6379`.

## Environment variables

Required runtime values include:

- `NODE_ENV`, `PORT`, and `SERVICE_NAME`
- `DATABASE_URL`, pointing to the service-owned MySQL database
- `REDIS_URL`
- `JWT_SECRET` and `JWT_ISSUER` for access-token verification
- `INTERNAL_AUTH_SECRET` and `INTERNAL_ALLOWED_SERVICES` for local internal service authentication
- `SYSTEM_ADMIN_USER_IDS`, the temporary authorization adapter configuration until the canonical RBAC contract is integrated

Do not commit `.env` or real secrets. Production secrets must come from the deployment secret manager. Compose values are development placeholders only.

## Database and Redis

Prisma migrations are the permanent schema-management strategy:

```bash
npm run prisma:generate
npm run prisma:deploy
```

The database contains only the service-owned `organizations` table and Prisma migration metadata. Redis is required for readiness and organization-create idempotency. If Redis cannot reserve an idempotency key, creation fails closed rather than creating an unprotected duplicate.

## APIs

Public APIs require `Authorization: Bearer <access-token>`. Organization creation additionally requires `Idempotency-Key`.

- `GET /health`
- `GET /health/ready`
- `POST /api/v1/organizations`
- `GET /api/v1/organizations`
- `GET /api/v1/organizations/:id`
- `PATCH /api/v1/organizations/:id`
- `PATCH /api/v1/organizations/:id/status`
- `GET /internal/v1/organizations/:id`
- `GET /internal/v1/organizations/by-slug/:slug`

See [docs/openapi.yaml](docs/openapi.yaml) for request schemas, responses, security schemes, pagination, examples, and error contracts.

Public create/list/status operations require System Administrator authorization. Organization reads and profile updates require a matching tenant context or System Administrator access. Internal APIs use service authentication and are not public JWT endpoints.

## Commands

- `npm run dev` starts the watch-mode server.
- `npm run build` compiles the production build.
- `npm run start` starts the compiled server.
- `npm run lint` runs ESLint.
- `npm run typecheck` runs TypeScript checking.
- `npm test` runs the full test suite.
- `npm run test:unit` runs unit/API/security tests.
- `npm run test:e2e` runs the Supertest organization lifecycle tests.
- `npm run test:integration` runs integration tests.
- `RUN_DB_TESTS=true npm run test:integration` enables live MySQL tests.
- `npm run prisma:deploy` applies committed migrations.

## Docker

Start local dependencies with `docker compose up -d mysql redis`. To build and run the complete service stack:

```bash
docker compose up --build
```

The application waits for healthy MySQL and Redis containers, applies migrations, exposes a liveness healthcheck, and runs as a non-root image user. Docker does not bake production secrets into the image.

## Observability and security

Pino logs include service name, request ID, trace ID, method, path, status, and duration. Authorization headers, cookies, internal signatures, and secrets are redacted. Error responses include timestamp, status, code, message, path, request ID, and trace ID without stack traces.

JWT verification, authorization, and internal service authentication are adapter boundaries. Local HMAC internal authentication is documented in [docs/phase-1.md](docs/phase-1.md) and [the ADR](docs/adr/0001-service-stack-and-boundaries.md); production must align those adapters with canonical Resolve platform contracts.

## CI

GitHub Actions is defined in [.github/workflows/ci.yml](.github/workflows/ci.yml). It starts MySQL and Redis services, applies Prisma migrations, runs lint, typecheck, all tests, and the production build.
