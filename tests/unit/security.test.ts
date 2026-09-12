import { createHmac } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { createJwtVerifier, createLocalJwksJwtVerifier } from '../../src/security/jwt.js';
import {
  createHmacInternalAuthService,
  createServiceJwtInternalAuthService,
} from '../../src/security/internal-auth.js';
import { createMemoryIdempotencyStore } from '../../src/infrastructure/redis/idempotency.js';
import type { TokenRevocationChecker } from '../../src/security/auth.types.js';

const secret = 'test-jwt-secret-that-is-at-least-32-characters';
const issuer = 'resolve-authentication-service'; // canonical issuer (Auth contract §3)

async function token(overrides: Record<string, unknown> = {}) {
  // Canonical claim set (Authentication contract §3): sub, tenantId, email,
  // tokenId, type: "access", iat, exp, iss.
  return new SignJWT({
    tenantId: 'tenant-a',
    tokenId: 'token-1',
    type: 'access',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject('user-a')
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(secret));
}

describe('JWT authentication (HS256 development fallback)', () => {
  const verifier = createJwtVerifier({ secret, issuer });

  it('accepts a valid access token and extracts only the auth context', async () => {
    await expect(verifier.verify(await token())).resolves.toEqual({
      userId: 'user-a',
      tenantId: 'tenant-a',
      tokenId: 'token-1',
    });
  });

  it.each<[string, string, Record<string, unknown>]>([
    ['invalid signature', 'wrong-secret', {}],
    ['expired token', secret, { exp: Math.floor(Date.now() / 1000) - 60 }],
    ['invalid issuer', secret, { iss: 'wrong-issuer' }],
    ['missing tenant claim', secret, { tenantId: undefined }],
    ['missing tokenId claim', secret, { tokenId: undefined }],
    ['missing sub claim', secret, { sub: undefined }],
    ['wrong token type', secret, { type: 'refresh' }],
  ])('rejects %s', async (_name, signingSecret, claims) => {
    const signed = await new SignJWT({
      tenantId: 'tenant-a',
      tokenId: 'token-1',
      type: 'access',
      ...claims,
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(claims.iss === 'wrong-issuer' ? 'wrong-issuer' : issuer)
      .setIssuedAt()
      .setExpirationTime(typeof claims.exp === 'number' ? claims.exp : '5m')
      .sign(new TextEncoder().encode(signingSecret));

    await expect(verifier.verify(signed)).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_MISSING_TOKEN',
    });
  });

  it('rejects a revoked token (session:revoked:{tokenId})', async () => {
    const revocationChecker: TokenRevocationChecker = { isRevoked: async () => true };
    const verifierWithCheck = createJwtVerifier({ secret, issuer, revocationChecker });

    await expect(verifierWithCheck.verify(await token())).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_MISSING_TOKEN',
    });
  });

  it('fails closed when revocation state cannot be verified', async () => {
    const revocationChecker: TokenRevocationChecker = {
      isRevoked: async () => {
        throw new Error('redis unavailable');
      },
    };
    const verifierWithCheck = createJwtVerifier({ secret, issuer, revocationChecker });

    await expect(verifierWithCheck.verify(await token())).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_MISSING_TOKEN',
    });
  });

  it('accepts a non-revoked token when a checker is configured', async () => {
    const revocationChecker: TokenRevocationChecker = { isRevoked: async () => false };
    const verifierWithCheck = createJwtVerifier({ secret, issuer, revocationChecker });

    await expect(verifierWithCheck.verify(await token())).resolves.toMatchObject({
      userId: 'user-a',
      tenantId: 'tenant-a',
    });
  });
});

describe('JWT authentication (canonical RS256/JWKS verification)', () => {
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'] | undefined;
  let jwks: { keys: Array<Record<string, unknown>> } | undefined;
  let canonicalToken = '';

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    const publicJwk = await exportJWK(pair.publicKey);
    jwks = { keys: [{ ...publicJwk, kid: '2026-09-key-1' }] };
    canonicalToken = await new SignJWT({
      tenantId: 'tenant-a',
      tokenId: 'token-1',
      type: 'access',
      email: 'jane.doe@acmebank.com',
    })
      .setProtectedHeader({ alg: 'RS256', kid: '2026-09-key-1' })
      .setSubject('user-a')
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(pair.privateKey);
  });

  it('verifies a canonical RS256 token', async () => {
    const verifier = createLocalJwksJwtVerifier({ jwks: jwks as never, issuer });
    await expect(verifier.verify(canonicalToken)).resolves.toEqual({
      userId: 'user-a',
      tenantId: 'tenant-a',
      tokenId: 'token-1',
    });
  });

  it('rejects a token signed by an unknown kid', async () => {
    const verifier = createLocalJwksJwtVerifier({ jwks: jwks as never, issuer });
    const signed = await new SignJWT({
      tenantId: 'tenant-a',
      tokenId: 'token-1',
      type: 'access',
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'rotated-away-key' })
      .setSubject('user-a')
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey as Awaited<ReturnType<typeof generateKeyPair>>['privateKey']);

    await expect(verifier.verify(signed)).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_MISSING_TOKEN',
    });
  });

  it('rejects an RS256 token with the wrong issuer', async () => {
    const verifier = createLocalJwksJwtVerifier({ jwks: jwks as never, issuer });
    const signed = await new SignJWT({
      tenantId: 'tenant-a',
      tokenId: 'token-1',
      type: 'access',
    })
      .setProtectedHeader({ alg: 'RS256', kid: '2026-09-key-1' })
      .setSubject('user-a')
      .setIssuer('evil-issuer')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey as Awaited<ReturnType<typeof generateKeyPair>>['privateKey']);

    await expect(verifier.verify(signed)).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_MISSING_TOKEN',
    });
  });
});

describe('internal service authentication (HMAC development fallback)', () => {
  const now = 1_700_000_000_000;
  const service = createHmacInternalAuthService({
    secret: 'internal-secret',
    allowedServices: ['user-service'],
    clock: () => now,
  });
  const sign = (message: string) =>
    createHmac('sha256', 'internal-secret').update(message).digest('hex');
  const timestamp = String(now / 1000);

  async function authenticate(message: string, overrides: Record<string, string> = {}) {
    return service.authenticate({
      serviceName: 'user-service',
      signature: sign(message),
      timestamp,
      method: 'GET',
      path: '/internal/v1/organizations/tenant-a',
      ...overrides,
    });
  }

  it('accepts an allowed, correctly signed request', async () => {
    await expect(
      authenticate(`user-service:${timestamp}:GET:/internal/v1/organizations/tenant-a`),
    ).resolves.toEqual({ serviceName: 'user-service' });
  });

  it('rejects requests missing credentials', async () => {
    await expect(
      service.authenticate({
        method: 'GET',
        path: '/internal/v1/organizations/tenant-a',
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'INTERNAL_AUTH_INVALID' });
  });

  it('rejects a wrong/invalid service identity', async () => {
    await expect(
      service.authenticate({
        serviceName: 'unknown-service',
        signature: '00',
        timestamp,
        method: 'GET',
        path: '/internal/v1/organizations/a',
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'INTERNAL_AUTH_INVALID' });
  });

  it('rejects a stale timestamp', async () => {
    const stale = String(now / 1000 - 10_000);
    const message = `user-service:${stale}:GET:/internal/v1/organizations/tenant-a`;
    await expect(authenticate(message, { timestamp: stale })).rejects.toMatchObject({
      statusCode: 401,
      code: 'INTERNAL_AUTH_INVALID',
    });
  });

  it('rejects a modified path', async () => {
    const message = `user-service:${timestamp}:GET:/internal/v1/organizations/tenant-a`;
    await expect(
      authenticate(message, { path: '/internal/v1/organizations/OTHER' }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'INTERNAL_AUTH_INVALID' });
  });

  it('rejects a modified HTTP method', async () => {
    const message = `user-service:${timestamp}:GET:/internal/v1/organizations/tenant-a`;
    await expect(authenticate(message, { method: 'POST' })).rejects.toMatchObject({
      statusCode: 401,
      code: 'INTERNAL_AUTH_INVALID',
    });
  });

  it('rejects a replayed request within the skew window', async () => {
    const isolatedService = createHmacInternalAuthService({
      secret: 'internal-secret',
      allowedServices: ['user-service'],
      clock: () => now,
    });
    const authenticateIsolated = (message: string) =>
      isolatedService.authenticate({
        serviceName: 'user-service',
        signature: sign(message),
        timestamp,
        method: 'GET',
        path: '/internal/v1/organizations/tenant-a',
      });
    const message = `user-service:${timestamp}:GET:/internal/v1/organizations/tenant-a`;
    await authenticateIsolated(message);
    await expect(authenticateIsolated(message)).rejects.toMatchObject({
      statusCode: 401,
      code: 'INTERNAL_AUTH_INVALID',
    });
  });
});

describe('internal service authentication (canonical signed service JWT)', () => {
  const service = createServiceJwtInternalAuthService({
    issuer,
    allowedServices: ['user-service'],
    secret,
  });

  async function serviceToken(
    overrides: Record<string, unknown> = {},
    header: Record<string, string> = {},
  ) {
    const exp =
      typeof overrides.exp === 'number'
        ? (overrides.exp as number)
        : Math.floor(Date.now() / 1000) + 300;
    return new SignJWT({
      service: 'user-service',
      type: 'service',
      exp,
      ...overrides,
    })
      .setProtectedHeader({ alg: 'HS256', ...header })
      .setIssuer(issuer)
      .setIssuedAt()
      .sign(new TextEncoder().encode(secret));
  }

  it('accepts a valid signed service token', async () => {
    const signed = await serviceToken();
    await expect(
      service.authenticate({
        authorization: `Bearer ${signed}`,
        method: 'GET',
        path: '/internal/v1/organizations/tenant-a',
      }),
    ).resolves.toEqual({ serviceName: 'user-service' });
  });

  it('rejects missing credentials', async () => {
    await expect(
      service.authenticate({ method: 'GET', path: '/internal/v1/organizations/a' }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'INTERNAL_AUTH_REQUIRED' });
  });

  it('rejects an end-user access token (type "access")', async () => {
    const endUser = await serviceToken({ type: 'access' });
    await expect(
      service.authenticate({
        authorization: `Bearer ${endUser}`,
        method: 'GET',
        path: '/internal/v1/organizations/tenant-a',
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'INTERNAL_AUTH_INVALID' });
  });

  it('rejects a token for a non-allowed service', async () => {
    const signed = await serviceToken({ service: 'case-service' });
    await expect(
      service.authenticate({
        authorization: `Bearer ${signed}`,
        method: 'GET',
        path: '/internal/v1/organizations/tenant-a',
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'INTERNAL_AUTH_INVALID' });
  });

  it('rejects an expired service token', async () => {
    const signed = await serviceToken({ exp: Math.floor(Date.now() / 1000) - 60 });
    await expect(
      service.authenticate({
        authorization: `Bearer ${signed}`,
        method: 'GET',
        path: '/internal/v1/organizations/tenant-a',
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'INTERNAL_AUTH_INVALID' });
  });

  it('rejects a token with a wrong signature', async () => {
    const signed = await new SignJWT({
      service: 'user-service',
      type: 'service',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode('ANOTHER-secret-that-is-also-32-characters-long'));
    await expect(
      service.authenticate({
        authorization: `Bearer ${signed}`,
        method: 'GET',
        path: '/internal/v1/organizations/tenant-a',
      }),
    ).rejects.toMatchObject({ statusCode: 401, code: 'INTERNAL_AUTH_INVALID' });
  });
});

describe('Redis idempotency contract', () => {
  it('replays the same result, rejects different input, and serializes concurrent work', async () => {
    const store = createMemoryIdempotencyStore();
    let calls = 0;
    const operation = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { statusCode: 201, body: { id: 'organization-1' } };
    };

    const first = await store.execute('key-1', { name: 'Acme' }, operation);
    const retry = await store.execute('key-1', { name: 'Acme' }, operation);
    const concurrent = await Promise.allSettled([
      store.execute('key-2', { name: 'Acme' }, operation),
      store.execute('key-2', { name: 'Acme' }, operation),
    ]);
    const different = store.execute('key-1', { name: 'Other' }, operation);

    expect(first).toEqual(retry);
    expect(calls).toBe(2);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    await expect(different).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
  });
});
