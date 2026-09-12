import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';
import { AppError } from '../shared/errors.js';
import type { InternalAuthService } from './auth.types.js';

const INTERNAL_AUTH_REQUIRED = new AppError(
  401,
  'INTERNAL_AUTH_REQUIRED',
  'Internal service authentication is required',
);

const INTERNAL_AUTH_INVALID = new AppError(
  401,
  'INTERNAL_AUTH_INVALID',
  'Invalid internal service credentials',
);

const maxReplayEntries = 10_000;

/**
 * Local DEVELOPMENT fallback only — HMAC-SHA256 request signing.
 *
 * The canonical Resolve service-to-service contract is mTLS client cert or a
 * signed service-to-service JWT carrying a `service` claim; this HMAC adapter
 * exists so the service can be exercised locally without the platform
 * infrastructure, and `server.ts` refuses to start it when
 * `NODE_ENV=production`. It signs `service:timestamp:METHOD:path` and enforces
 * a clock-skew window plus a replay cache (a replayed message within the
 * window is rejected).
 */
export function createHmacInternalAuthService(options: {
  secret: string;
  allowedServices: string[];
  clock?: () => number;
  maxClockSkewSeconds?: number;
}): InternalAuthService {
  const allowedServices = new Set(options.allowedServices);
  const clock = options.clock ?? (() => Date.now());
  const maxClockSkewSeconds = options.maxClockSkewSeconds ?? 300;
  const replayWindowMs = maxClockSkewSeconds * 1000;
  // message -> expiry (ms); insertion-ordered for FIFO eviction at capacity.
  const replayWindows = new Map<string, number>();

  return {
    async authenticate(headers) {
      const { serviceName, signature, timestamp, method, path } = headers;
      const timestampNumber = Number(timestamp);
      if (
        !serviceName ||
        !signature ||
        !timestamp ||
        !allowedServices.has(serviceName) ||
        !Number.isInteger(timestampNumber) ||
        Math.abs(clock() / 1000 - timestampNumber) > maxClockSkewSeconds
      ) {
        throw INTERNAL_AUTH_INVALID;
      }

      const message = `${serviceName}:${timestamp}:${method.toUpperCase()}:${path}`;
      const expected = createHmac('sha256', options.secret).update(message).digest('hex');
      const actualBuffer = Buffer.from(signature, 'hex');
      const expectedBuffer = Buffer.from(expected, 'hex');
      if (
        actualBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(actualBuffer, expectedBuffer)
      ) {
        throw INTERNAL_AUTH_INVALID;
      }

      const now = clock();
      for (const [seen, expiry] of replayWindows) {
        if (expiry < now) {
          replayWindows.delete(seen);
        }
      }
      if (replayWindows.has(message)) {
        // Exact replay of an already-seen request within the skew window.
        throw INTERNAL_AUTH_INVALID;
      }
      replayWindows.set(message, now + replayWindowMs);
      while (replayWindows.size > maxReplayEntries) {
        const oldest = replayWindows.keys().next().value;
        if (oldest === undefined) break;
        replayWindows.delete(oldest);
      }

      return { serviceName };
    },
  };
}

interface ServiceJwtPayload extends JWTPayload {
  service?: unknown;
  type?: unknown;
}

const canonicalServiceIssuer = 'resolve-authentication-service';

/**
 * Canonical internal service authentication: a signed service-to-service JWT
 * carrying a `service` claim (Organization contract §1; Authentication
 * contract). The caller's forwarded end-user token is never accepted — the
 * token must be a dedicated service token (`type: "service"`) signed by the
 * platform identity issuer. mTLS termination is expected at the gateway/TLS
 * layer; this adapter implements the signed-service-JWT leg.
 *
 * Token verification uses RS256 against the platform JWKS when `jwksUrl` (or a
 * static `jwks` set) is configured — matching the canonical access-token
 * mechanism — or HS256 with `secret` for standalone/local setups.
 */
export function createServiceJwtInternalAuthService(options: {
  issuer?: string;
  allowedServices: string[];
  jwksUrl?: string;
  jwks?: JSONWebKeySet;
  secret?: string;
}): InternalAuthService {
  const allowedServices = new Set(options.allowedServices);
  const issuer = options.issuer ?? canonicalServiceIssuer;

  const localJwks = options.jwks ? createLocalJWKSet(options.jwks) : undefined;
  const remoteJwks = options.jwksUrl ? createRemoteJWKSet(new URL(options.jwksUrl)) : undefined;
  const jwkSet = localJwks ?? remoteJwks;
  const hs256Key = options.secret ? new TextEncoder().encode(options.secret) : undefined;
  if (!jwkSet && !hs256Key) {
    throw new Error('service-jwt internal authentication requires one of: jwksUrl, jwks, secret');
  }

  return {
    async authenticate(headers) {
      const authorization = headers.authorization;
      if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
        throw INTERNAL_AUTH_REQUIRED;
      }
      const token = authorization.replace(/^Bearer\s+/i, '').trim();

      try {
        const result = jwkSet
          ? await jwtVerify<ServiceJwtPayload>(token, jwkSet, {
              issuer,
              algorithms: ['RS256'],
            })
          : await jwtVerify<ServiceJwtPayload>(token, hs256Key!, {
              issuer,
              algorithms: ['HS256'],
            });
        const payload = result.payload;

        if (
          typeof payload.service !== 'string' ||
          !allowedServices.has(payload.service) ||
          payload.type !== 'service'
        ) {
          throw INTERNAL_AUTH_INVALID;
        }

        return { serviceName: payload.service };
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw INTERNAL_AUTH_INVALID;
      }
    },
  };
}
