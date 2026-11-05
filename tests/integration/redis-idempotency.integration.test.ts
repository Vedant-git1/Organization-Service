import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRedisIdempotencyStore,
  requestHash,
} from '../../src/infrastructure/redis/idempotency.js';

/**
 * Live Redis integration coverage (requirements §12/§18): the idempotency
 * store must be exercised against a real Redis instance, not a fake — the
 * namespace, TTLs, replay semantics, concurrent duplicates, and failure
 * behaviour all depend on Redis primitives (`SET ... EX NX`, `TTL`, `DEL`).
 *
 * Enabled with `RUN_DB_TESTS=true` after `docker compose up -d mysql redis`.
 */
const runLiveTests = process.env.RUN_DB_TESTS === 'true';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

const redis = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
const reservedKeys: string[] = [];

function trackKey(key: string): string {
  const storageKey = `idempotency:${key}`;
  reservedKeys.push(storageKey);
  return storageKey;
}

describe.skipIf(!runLiveTests)('Redis-backed idempotency (live Redis)', () => {
  beforeAll(async () => {
    await redis.connect();
  });

  afterAll(async () => {
    if (reservedKeys.length > 0) {
      await redis.del(...reservedKeys);
    }
    await redis.quit();
  });

  it('stores results under the canonical namespace with a bounded TTL', async () => {
    const store = createRedisIdempotencyStore(redis);
    const key = `live-namespace-${randomUUID()}`;
    const storageKey = trackKey(key);

    const result = await store.execute(key, { name: 'Acme' }, async () => ({
      statusCode: 201,
      body: { id: 'organization-1' },
    }));

    expect(result.statusCode).toBe(201);
    expect(await redis.exists(storageKey)).toBe(1);
    // Completed results live for 24h; anything lower would break replay and
    // anything unbounded would leak keys forever.
    const ttl = await redis.ttl(storageKey);
    expect(ttl).toBeGreaterThan(80000);
    expect(ttl).toBeLessThanOrEqual(86400);
  });

  it('replays the original response for a repeated key and body', async () => {
    const store = createRedisIdempotencyStore(redis);
    const key = `live-replay-${randomUUID()}`;
    trackKey(key);
    let calls = 0;
    const operation = async () => {
      calls += 1;
      return { statusCode: 201, body: { id: `organization-${calls}` } };
    };

    const first = await store.execute(key, { name: 'Acme', slug: 'acme' }, operation);
    const retry = await store.execute(key, { name: 'Acme', slug: 'acme' }, operation);

    expect(retry).toEqual(first);
    expect(calls).toBe(1);
  });

  it('rejects the same key with a different body', async () => {
    const store = createRedisIdempotencyStore(redis);
    const key = `live-conflict-${randomUUID()}`;
    trackKey(key);

    await store.execute(key, { name: 'Acme', slug: 'acme' }, async () => ({
      statusCode: 201,
      body: { id: 'organization-1' },
    }));

    await expect(
      store.execute(key, { name: 'Other', slug: 'other' }, async () => ({
        statusCode: 201,
        body: { id: 'organization-2' },
      })),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('runs concurrent duplicate requests exactly once and gives both the same result', async () => {
    const store = createRedisIdempotencyStore(redis);
    const key = `live-concurrent-${randomUUID()}`;
    trackKey(key);
    let calls = 0;
    const operation = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { statusCode: 201, body: { id: 'organization-1' } };
    };

    const [first, second] = await Promise.all([
      store.execute(key, { name: 'Acme' }, operation),
      store.execute(key, { name: 'Acme' }, operation),
    ]);

    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });

  it('reports a stalled in-flight key as a defined conflict', async () => {
    const store = createRedisIdempotencyStore(redis, { pendingWaitTimeoutMs: 50 });
    const key = `live-stalled-${randomUUID()}`;
    const storageKey = trackKey(key);
    const body = { name: 'Acme' };
    // Simulate a request that reserved the key and never completed.
    await redis.set(
      storageKey,
      JSON.stringify({ hash: requestHash(body), state: 'pending' }),
      'EX',
      120,
    );

    await expect(
      store.execute(key, body, async () => ({ statusCode: 201, body: { id: 'organization-1' } })),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' });
  });

  it('releases the reservation when the operation fails so a retry can succeed', async () => {
    const store = createRedisIdempotencyStore(redis);
    const key = `live-release-${randomUUID()}`;
    const storageKey = trackKey(key);

    await expect(
      store.execute(key, { name: 'Acme' }, async () => {
        throw new Error('validation failed');
      }),
    ).rejects.toThrow('validation failed');
    expect(await redis.exists(storageKey)).toBe(0);

    const retry = await store.execute(key, { name: 'Acme' }, async () => ({
      statusCode: 201,
      body: { id: 'organization-1' },
    }));
    expect(retry.statusCode).toBe(201);
  });

  it('fails closed with 503 when Redis is unreachable', async () => {
    // Nothing is listening on this port; retries are disabled so the failure is
    // immediate rather than hanging the request.
    const brokenRedis = new Redis('redis://127.0.0.1:6399', {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      connectTimeout: 500,
    });
    brokenRedis.on('error', () => undefined);
    const store = createRedisIdempotencyStore(brokenRedis);

    await expect(
      store.execute(`live-unreachable-${randomUUID()}`, { name: 'Acme' }, async () => ({
        statusCode: 201,
        body: { id: 'organization-1' },
      })),
    ).rejects.toMatchObject({ statusCode: 503, code: 'ORG_DEPENDENCY_UNAVAILABLE' });

    await brokenRedis.disconnect();
  });
});
