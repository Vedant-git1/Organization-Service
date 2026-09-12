# Phase 1 Boundaries

The Organization Service foundation owns organization identity storage and runtime infrastructure.

## Included

- MySQL 8 schema and Prisma migration for `organizations`
- Redis connectivity and readiness checks
- Centralized environment validation
- Express application/server separation
- Structured Pino request logging
- Liveness and readiness endpoints
- Centralized error response infrastructure

## Deferred

Authentication, authorization, idempotency, Kafka events, and user/team/case integrations are intentionally deferred to later phases. Public organization management APIs are implemented in Phase 2.

No Resolve contract documents were present in this repository when Phase 1 was implemented; the explicit Phase 1 request is the source of truth for this foundation.

Phase 3 security assumes HS256 access JWTs and HMAC internal service credentials locally because Authentication, User/Team, and RBAC contract documents were not present in this repository. These mechanisms are isolated behind adapters and must be aligned with the canonical platform contracts before production integration.
