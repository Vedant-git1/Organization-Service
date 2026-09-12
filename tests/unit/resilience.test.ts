import { describe, expect, it } from 'vitest';
import {
  createMemoryIdempotencyStore,
  createRedisIdempotencyStore,
} from '../../src/infrastructure/redis/idempotency.js';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import type { JwtVerifier } from '../../src/security/jwt.js';
import type { AuthorizationService } from '../../src/security/auth.types.js';
import request from 'supertest';

const config = loadConfig({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'mysql://test:test@localhost:3307/resolve_organization',
  REDIS_URL: 'redis://localhost:6379',
  SERVICE_NAME: 'organization-service-test',
  LOG_LEVEL: 'silent',
});

describe('dependency failure behavior', () => {
  it('returns 500 when authorization infrastructure fails', async () => {
    const jwtVerifier: JwtVerifier = {
      verify: async () => ({ userId: 'user', tenantId: 'tenant', tokenId: 'token' }),
    };
    const authorization: AuthorizationService = {
      isSystemAdministrator: async () => {
        throw new Error('authorization service unavailable');
      },
    };
    const app = createApp(config, {
      checkDatabase: async () => undefined,
      checkRedis: async () => undefined,
      jwtVerifier,
      authorizationService: authorization,
    });

    const response = await request(app)
      .get('/api/v1/organizations')
      .set('authorization', 'Bearer test');

    expect(response.status).toBe(500);
    expect(response.body).toMatchObject({
      status: 500,
      code: 'INTERNAL_SERVER_ERROR',
    });
  });

  it('fails closed when Redis cannot reserve an idempotency key', async () => {
    const redis = {
      set: async () => {
        throw new Error('redis unavailable');
      },
      get: async () => null,
      del: async () => 0,
    };
    const store = createRedisIdempotencyStore(redis);

    await expect(
      store.execute('key', { name: 'Acme' }, async () => ({
        statusCode: 201,
        body: { id: 'org' },
      })),
    ).rejects.toThrow('redis unavailable');
  });

  it('uses the canonical Redis key namespace and reservation TTL', async () => {
    const calls: unknown[][] = [];
    const redis = {
      set: async (...args: unknown[]): Promise<'OK'> => {
        calls.push(args);
        return 'OK';
      },
      get: async () => null,
      del: async () => 0,
    };
    const store = createRedisIdempotencyStore(redis);

    await store.execute('namespace-key', { name: 'Acme' }, async () => ({
      statusCode: 201,
      body: { id: 'org' },
    }));

    expect(calls[0]).toEqual(['idempotency:namespace-key', expect.any(String), 'EX', 120, 'NX']);
    expect(calls[1]?.[0]).toBe('idempotency:namespace-key');
    expect(calls[1]?.[2]).toBe('EX');
    expect(calls[1]?.[3]).toBe(86400);
  });

  it('provides deterministic in-memory behavior for tests without Redis', async () => {
    const store = createMemoryIdempotencyStore();
    await expect(
      store.execute('key', { name: 'Acme' }, async () => ({
        statusCode: 201,
        body: { id: 'org' },
      })),
    ).resolves.toEqual({ statusCode: 201, body: { id: 'org' } });
  });
});
