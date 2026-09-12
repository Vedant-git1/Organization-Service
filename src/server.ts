import { loadConfig } from './config/env.js';
import { createApp } from './app.js';
import {
  prisma,
  disconnectDatabase,
  checkDatabaseHealth,
} from './infrastructure/database/prisma.js';
import { createRedisClient, checkRedisHealth } from './infrastructure/redis/client.js';
import { createRedisRevocationChecker } from './infrastructure/redis/revocation.js';
import { createLogger } from './shared/logger.js';
import { createJwtVerifier, createJwksJwtVerifier } from './security/jwt.js';
import { createConfiguredAuthorizationService } from './security/authorization.js';
import {
  createHmacInternalAuthService,
  createServiceJwtInternalAuthService,
} from './security/internal-auth.js';
import { createRedisIdempotencyStore } from './infrastructure/redis/idempotency.js';

const config = loadConfig();
const logger = createLogger(config);

// Canonical JWT verification (Authentication contract §7): access tokens are
// RS256 signed by the Authentication Service and verified against its JWKS.
// HS256 with a shared secret is the local development fallback and is refused
// in production so a non-canonical mechanism cannot silently handle authN.
if (config.NODE_ENV === 'production' && config.JWT_ALGORITHM !== 'rs256') {
  throw new Error(
    'Production requires JWT_ALGORITHM=rs256 (canonical RS256/JWKS verification); ' +
      'HS256 is a local development fallback.',
  );
}
if (config.JWT_ALGORITHM === 'rs256' && !config.JWT_JWKS_URL) {
  throw new Error('JWT_JWKS_URL is required when JWT_ALGORITHM=rs256');
}
if (config.JWT_ALGORITHM === 'hs256' && !config.JWT_SECRET) {
  throw new Error('JWT_SECRET is required when JWT_ALGORITHM=hs256');
}

// Canonical internal service authentication: mTLS client cert or a signed
// service-to-service JWT carrying a `service` claim. The local HMAC scheme is
// a development fallback and is refused in production.
if (config.NODE_ENV === 'production' && config.INTERNAL_AUTH_MODE !== 'service-jwt') {
  throw new Error(
    'Production requires INTERNAL_AUTH_MODE=service-jwt (canonical service-to-service JWT); ' +
      'the HMAC scheme is a local development fallback.',
  );
}
if (
  config.INTERNAL_AUTH_MODE === 'service-jwt' &&
  !config.INTERNAL_JWT_JWKS_URL &&
  !config.INTERNAL_AUTH_SECRET
) {
  throw new Error(
    'INTERNAL_JWT_JWKS_URL (or INTERNAL_AUTH_SECRET) is required when INTERNAL_AUTH_MODE=service-jwt',
  );
}
if (config.INTERNAL_AUTH_MODE === 'hmac' && !config.INTERNAL_AUTH_SECRET) {
  throw new Error('INTERNAL_AUTH_SECRET is required when INTERNAL_AUTH_MODE=hmac');
}

// Canonical RBAC (System Administrator resolution) lives in the RBAC Service
// (Task 5); its contract is not available in this workspace. Until it is
// integrated, the static SYSTEM_ADMIN_USER_IDS list is the documented local
// fallback — production is told explicitly that this is the current state.
if (config.NODE_ENV === 'production') {
  if (config.SYSTEM_ADMIN_USER_IDS.length === 0) {
    throw new Error(
      'Production requires SYSTEM_ADMIN_USER_IDS until the canonical RBAC contract is integrated',
    );
  }
  logger.warn(
    { adminCount: config.SYSTEM_ADMIN_USER_IDS.length },
    'WARNING: System Administrator authorization uses the static SYSTEM_ADMIN_USER_IDS fallback; ' +
      'the canonical RBAC integration is unresolved (see docs/adr/0002-*.md).',
  );
}

const redis = createRedisClient(config);
const revocationChecker = createRedisRevocationChecker(redis);

const jwtVerifier =
  config.JWT_ALGORITHM === 'rs256'
    ? createJwksJwtVerifier({
        jwksUrl: config.JWT_JWKS_URL as string,
        issuer: config.JWT_ISSUER,
        ...(config.JWT_AUDIENCE ? { audience: config.JWT_AUDIENCE } : {}),
        revocationChecker,
      })
    : createJwtVerifier({
        secret: config.JWT_SECRET as string,
        issuer: config.JWT_ISSUER,
        ...(config.JWT_AUDIENCE ? { audience: config.JWT_AUDIENCE } : {}),
        revocationChecker,
      });

const internalAuthService =
  config.INTERNAL_AUTH_MODE === 'service-jwt'
    ? createServiceJwtInternalAuthService({
        issuer: config.INTERNAL_JWT_ISSUER,
        allowedServices: config.INTERNAL_ALLOWED_SERVICES,
        ...(config.INTERNAL_JWT_JWKS_URL
          ? { jwksUrl: config.INTERNAL_JWT_JWKS_URL as string }
          : { secret: config.INTERNAL_AUTH_SECRET as string }),
      })
    : createHmacInternalAuthService({
        secret: config.INTERNAL_AUTH_SECRET as string,
        allowedServices: config.INTERNAL_ALLOWED_SERVICES,
      });

const app = createApp(config, {
  checkDatabase: () => checkDatabaseHealth(prisma),
  checkRedis: () => checkRedisHealth(redis),
  jwtVerifier,
  authorizationService: createConfiguredAuthorizationService(config.SYSTEM_ADMIN_USER_IDS),
  internalAuthService,
  idempotencyStore: createRedisIdempotencyStore(redis),
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'HTTP server listening');
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down');
  server.close(async () => {
    await redis.quit();
    await disconnectDatabase();
    process.exit(0);
  });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
