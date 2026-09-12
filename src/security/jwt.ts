import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { AppError } from '../shared/errors.js';
import type { AuthContext, TokenRevocationChecker } from './auth.types.js';

export interface JwtVerifier {
  verify(token: string): Promise<AuthContext>;
}

/**
 * Payload shape per the canonical Authentication Service contract (§3, schema
 * §6): `sub` (user id), `tenantId` (= organizations.id, FR-TEN-04), `email`
 * (convenience), `tokenId` (revocation key), `type` ("access"), `iat`, `exp`,
 * `iss` ("resolve-authentication-service"), `kid`. Roles/permissions are
 * deliberately absent.
 */
interface ResolveJwtPayload extends JWTPayload {
  tenantId?: unknown;
  tokenId?: unknown;
  type?: unknown;
}

const TOKEN_VERIFICATION_ERROR = new AppError(
  401,
  'AUTH_MISSING_TOKEN',
  'Authentication token is invalid',
);

/**
 * Validates the canonical required claims and applies the mandatory revocation
 * check when a checker is configured (Authentication contract §3, FR-IAM-06).
 * Revocation state that cannot be verified fails closed (auth schema §12).
 */
async function toAuthContext(
  payload: ResolveJwtPayload,
  revocationChecker: TokenRevocationChecker | undefined,
): Promise<AuthContext> {
  if (
    typeof payload.sub !== 'string' ||
    typeof payload.tenantId !== 'string' ||
    typeof payload.tokenId !== 'string' ||
    payload.type !== 'access'
  ) {
    throw TOKEN_VERIFICATION_ERROR;
  }

  if (revocationChecker) {
    let revoked: boolean;
    try {
      revoked = await revocationChecker.isRevoked(payload.tokenId);
    } catch {
      // Fail closed: a token whose revocation state cannot be verified must not
      // be accepted (FR-IAM-06, Authentication schema §12).
      throw TOKEN_VERIFICATION_ERROR;
    }
    if (revoked) {
      throw TOKEN_VERIFICATION_ERROR;
    }
  }

  return {
    userId: payload.sub,
    tenantId: payload.tenantId,
    tokenId: payload.tokenId,
  };
}

/**
 * Local development fallback verifier: HS256 shared-secret access tokens.
 * The canonical production mechanism is RS256 verified against the
 * Authentication Service JWKS (`/.well-known/jwks.json`) — see
 * `createJwksJwtVerifier`.
 */
export function createJwtVerifier(options: {
  secret: string;
  issuer: string;
  audience?: string;
  revocationChecker?: TokenRevocationChecker;
}): JwtVerifier {
  const key = new TextEncoder().encode(options.secret);

  return {
    async verify(token) {
      try {
        const result = await jwtVerify<ResolveJwtPayload>(token, key, {
          issuer: options.issuer,
          ...(options.audience ? { audience: options.audience } : {}),
          algorithms: ['HS256'],
        });
        return await toAuthContext(result.payload, options.revocationChecker);
      } catch {
        throw TOKEN_VERIFICATION_ERROR;
      }
    },
  };
}

/**
 * Canonical verifier: RS256 signed access tokens verified against the
 * Authentication Service JWKS, selecting the signing key by `kid`
 * (Authentication schema §7 verification contract: read kid → load cached
 * JWKS key → on miss refresh JWKS → verify RS256 signature → validate issuer,
 * exp, sub, tenantId, type → check Redis revocation marker).
 */
export function createJwksJwtVerifier(options: {
  jwksUrl: string;
  issuer: string;
  audience?: string;
  revocationChecker?: TokenRevocationChecker;
}): JwtVerifier {
  const jwks = createRemoteJWKSet(new URL(options.jwksUrl));

  return {
    async verify(token) {
      try {
        const result = await jwtVerify<ResolveJwtPayload>(token, jwks, {
          issuer: options.issuer,
          ...(options.audience ? { audience: options.audience } : {}),
          algorithms: ['RS256'],
        });
        return await toAuthContext(result.payload, options.revocationChecker);
      } catch {
        throw TOKEN_VERIFICATION_ERROR;
      }
    },
  };
}

/**
 * RS256 verifier bound to a statically provided JWKS (used by tests and local
 * configurations that are handed a known key set instead of a JWKS URL).
 */
export function createLocalJwksJwtVerifier(options: {
  jwks: Parameters<typeof createLocalJWKSet>[0];
  issuer: string;
  audience?: string;
  revocationChecker?: TokenRevocationChecker;
}): JwtVerifier {
  const jwks = createLocalJWKSet(options.jwks);

  return {
    async verify(token) {
      try {
        const result = await jwtVerify<ResolveJwtPayload>(token, jwks, {
          issuer: options.issuer,
          ...(options.audience ? { audience: options.audience } : {}),
          algorithms: ['RS256'],
        });
        return await toAuthContext(result.payload, options.revocationChecker);
      } catch {
        throw TOKEN_VERIFICATION_ERROR;
      }
    },
  };
}
