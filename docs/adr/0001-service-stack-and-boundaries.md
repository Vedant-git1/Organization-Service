# ADR 0001: Organization Service Stack and Boundaries

## Status

Accepted for the current repository implementation.

## Context

The original Resolve documentation described a Java/Spring Boot, PostgreSQL, modular-monolith-oriented implementation. The Organization Service is being delivered as an independently deployable service repository with the Phase 1-4 requirements supplied for this project.

## Decision

Use Node.js 20, TypeScript, Express, MySQL 8, Prisma, Zod, Redis, Pino, Vitest, Supertest, Docker, and npm.

The service owns the `resolve_organization` MySQL database and the `organizations` table. Other Resolve services must use the documented internal organization lookup APIs rather than connecting directly to this database.

Organization domain rules, tenant boundaries, authentication/authorization adapter boundaries, API paths, and status/slug constraints remain aligned with the supplied Resolve requirements. Kafka events, RBAC data ownership, users, teams, cases, and other unrelated domains remain outside this service.

## Security and integration choices

- Public APIs use access JWTs through a replaceable `JwtVerifier` boundary.
- Authorization is represented by an `AuthorizationService`; this service does not create RBAC tables or claim ownership of role management.
- Local internal service authentication uses HMAC headers through a replaceable `InternalAuthService`. Production deployments should bind this adapter to the platform-standard mTLS or service-mesh identity mechanism.
- Organization creation uses Redis-backed idempotency with an atomic reservation and request hash.
- Request and trace IDs are propagated, and credentials are redacted from Pino request logs.

## Consequences

The current repository is independently deployable and testable with local Docker infrastructure. Before production integration, the adapter assumptions must be reconciled with canonical Authentication, User/Team, RBAC, and internal service contracts because those documents were not present in this repository.
