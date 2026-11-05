import { createHmac, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';
import { prisma, checkDatabaseHealth } from '../../src/infrastructure/database/prisma.js';
import { checkRedisHealth } from '../../src/infrastructure/redis/client.js';
import { createRedisIdempotencyStore } from '../../src/infrastructure/redis/idempotency.js';
import { createRedisRevocationChecker } from '../../src/infrastructure/redis/revocation.js';
import { createOrganizationRepository } from '../../src/modules/organization/organization.repository.js';
import { createConfiguredAuthorizationService } from '../../src/security/authorization.js';
import { createHmacInternalAuthService } from '../../src/security/internal-auth.js';
import { createJwtVerifier } from '../../src/security/jwt.js';

/**
 * Full-stack HTTP integration coverage: real Express app, real MySQL (Prisma
 * repository), real Redis (idempotency + revocation), real JWT verification and
 * real internal-service authentication.
 *
 * Enabled with `RUN_DB_TESTS=true` after `docker compose up -d mysql redis`
 * and `npm run prisma:deploy`.
 */
const runLiveTests = process.env.RUN_DB_TESTS === 'true';
const jwtSecret = 'live-integration-jwt-secret-at-least-32-characters';
const jwtIssuer = 'resolve-authentication-service';
const internalSecret = 'live-integration-internal-secret-at-least-32-characters';
const adminUserId = 'live-system-admin';
const createdSlugs: string[] = [];

const config = loadConfig({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: process.env.DATABASE_URL ?? 'mysql://localhost:3307/resolve_organization',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  SERVICE_NAME: 'organization-service-live-integration',
  LOG_LEVEL: 'silent',
});

const redis = new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });

const app = createApp(config, {
  checkDatabase: () => checkDatabaseHealth(prisma),
  checkRedis: () => checkRedisHealth(redis),
  organizationRepository: createOrganizationRepository(prisma),
  jwtVerifier: createJwtVerifier({
    secret: jwtSecret,
    issuer: jwtIssuer,
    revocationChecker: createRedisRevocationChecker(redis),
  }),
  authorizationService: createConfiguredAuthorizationService([adminUserId]),
  internalAuthService: createHmacInternalAuthService({
    secret: internalSecret,
    allowedServices: ['user-service'],
  }),
  idempotencyStore: createRedisIdempotencyStore(redis),
});

/** Canonical access token: sub, tenantId, email, tokenId, type, iat, exp, iss. */
async function accessToken(userId: string, tenantId: string): Promise<string> {
  return new SignJWT({ tenantId, tokenId: randomUUID(), type: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(jwtIssuer)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(jwtSecret));
}

// Supersets of the tokens the suite needs, generated once so request builders
// stay synchronous (supertest `Test` objects must be chained, not awaited).
let systemAdminToken = '';
const tenantTokens = new Map<string, string>();

async function tenantToken(tenantId: string): Promise<string> {
  const cached = tenantTokens.get(tenantId);
  if (cached) return cached;
  const token = await accessToken(`user-of-${tenantId}`, tenantId);
  tenantTokens.set(tenantId, token);
  return token;
}

function adminRequest(method: 'get' | 'post' | 'patch', path: string) {
  return request(app)[method](path).set('authorization', `Bearer ${systemAdminToken}`);
}

function userRequest(token: string, method: 'get' | 'post' | 'patch', path: string) {
  return request(app)[method](path).set('authorization', `Bearer ${token}`);
}

function internalRequest(
  method: 'get',
  path: string,
  options: { service?: string; secret?: string; timestamp?: string } = {},
) {
  const service = options.service ?? 'user-service';
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', options.secret ?? internalSecret)
    .update(`${service}:${timestamp}:${method.toUpperCase()}:${path}`)
    .digest('hex');
  return request(app).get(path).set({
    'x-internal-service': service,
    'x-internal-timestamp': timestamp,
    'x-internal-signature': signature,
  });
}

function uniqueSlug(label: string): string {
  const slug = `live-${label}-${randomUUID().slice(0, 8)}`;
  createdSlugs.push(slug);
  return slug;
}

describe.skipIf(!runLiveTests)('organization HTTP flows against real MySQL and Redis', () => {
  beforeAll(async () => {
    await redis.connect();
    systemAdminToken = await accessToken(adminUserId, 'system');
  });

  afterAll(async () => {
    if (createdSlugs.length > 0) {
      await prisma.organization.deleteMany({ where: { slug: { in: createdSlugs } } });
    }
    await redis.quit();
    await prisma.$disconnect();
  });

  it('reports readiness against the live dependencies', async () => {
    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ready',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('runs the full lifecycle: create, get, update, suspend, reactivate, list', async () => {
    const slug = uniqueSlug('lifecycle');
    const created = await adminRequest('post', '/api/v1/organizations')
      .set('idempotency-key', randomUUID())
      .send({ name: 'Lifecycle Live Organization', slug });

    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      name: 'Lifecycle Live Organization',
      slug,
      status: 'ACTIVE',
    });
    expect(created.body.createdAt).toEqual(expect.any(String));
    const id = created.body.id as string;

    const found = await adminRequest('get', `/api/v1/organizations/${id}`);
    expect(found.status).toBe(200);
    expect(found.body.id).toBe(id);

    const updated = await adminRequest('patch', `/api/v1/organizations/${id}`).send({
      name: 'Lifecycle Live Organization Updated',
    });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.name).toBe('Lifecycle Live Organization Updated');

    const suspended = await adminRequest('patch', `/api/v1/organizations/${id}/status`).send({
      status: 'SUSPENDED',
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe('SUSPENDED');

    const reactivated = await adminRequest('patch', `/api/v1/organizations/${id}/status`).send({
      status: 'ACTIVE',
    });
    expect(reactivated.body.status).toBe('ACTIVE');

    const listed = await adminRequest('get', `/api/v1/organizations?slug=${slug}&page=0&size=5`);
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ page: 0, size: 5, totalElements: 1, totalPages: 1 });
    expect(listed.body.content).toHaveLength(1);
  });

  it('rejects a duplicate slug through the database unique constraint', async () => {
    const slug = uniqueSlug('duplicate');
    const first = await adminRequest('post', '/api/v1/organizations')
      .set('idempotency-key', randomUUID())
      .send({ name: 'Duplicate A', slug });
    const second = await adminRequest('post', '/api/v1/organizations')
      .set('idempotency-key', randomUUID())
      .send({ name: 'Duplicate B', slug });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('ORG_SLUG_TAKEN');
  });

  it('creates exactly one organization when the same slug is submitted concurrently', async () => {
    const slug = uniqueSlug('concurrent');
    const attempts = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        adminRequest('post', '/api/v1/organizations')
          .set('idempotency-key', randomUUID())
          .send({ name: `Concurrent ${index}`, slug }),
      ),
    );
    const created = attempts.filter((response) => response.status === 201);
    const conflicts = attempts.filter((response) => response.status === 409);

    expect(created).toHaveLength(1);
    expect(conflicts).toHaveLength(3);
    for (const conflict of conflicts) {
      expect(conflict.body.code).toBe('ORG_SLUG_TAKEN');
    }
    expect(await prisma.organization.count({ where: { slug } })).toBe(1);
  });

  it('replays an idempotent create and rejects a reused key with a different body', async () => {
    const idempotencyKey = `live-idempotency-${randomUUID()}`;
    const slug = uniqueSlug('idempotent');
    const body = { name: 'Idempotent Live Organization', slug };

    const first = await adminRequest('post', '/api/v1/organizations')
      .set('idempotency-key', idempotencyKey)
      .send(body);
    const retry = await adminRequest('post', '/api/v1/organizations')
      .set('idempotency-key', idempotencyKey)
      .send(body);
    const conflict = await adminRequest('post', '/api/v1/organizations')
      .set('idempotency-key', idempotencyKey)
      .send({ name: 'Different Live Organization', slug: uniqueSlug('idempotent-other') });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await prisma.organization.count({ where: { slug } })).toBe(1);
    // The canonical Redis namespace is used for the replay record.
    expect(await redis.exists(`idempotency:${idempotencyKey}`)).toBe(1);
  });

  it('requires an Idempotency-Key for creation', async () => {
    const response = await adminRequest('post', '/api/v1/organizations').send({
      name: 'Missing Key Organization',
      slug: uniqueSlug('missing-key'),
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('enforces tenant isolation over HTTP (FR-TEN-04)', async () => {
    const slug = uniqueSlug('isolation');
    const created = await adminRequest('post', '/api/v1/organizations')
      .set('idempotency-key', randomUUID())
      .send({ name: 'Isolation Live Organization', slug });
    const id = created.body.id as string;

    const ownRead = await userRequest(await tenantToken(id), 'get', `/api/v1/organizations/${id}`);
    const foreignToken = await tenantToken(randomUUID());
    const crossRead = await userRequest(foreignToken, 'get', `/api/v1/organizations/${id}`);
    const crossUpdate = await userRequest(
      await tenantToken(id),
      'patch',
      `/api/v1/organizations/${id}`,
    ).send({ name: 'Tenant user rename attempt' });
    const crossStatus = await userRequest(
      await tenantToken(id),
      'patch',
      `/api/v1/organizations/${id}/status`,
    ).send({ status: 'SUSPENDED' });
    const crossList = await userRequest(await tenantToken(id), 'get', '/api/v1/organizations');

    expect(ownRead.status).toBe(200);
    expect(crossRead.status).toBe(403);
    expect(crossRead.body.code).toBe('ORG_FORBIDDEN');
    expect(crossUpdate.status).toBe(403);
    expect(crossStatus.status).toBe(403);
    expect(crossList.status).toBe(403);
  });

  it('rejects unauthenticated and non-administrative administrative requests', async () => {
    const slug = uniqueSlug('unauthenticated');
    const unauthenticated = await request(app)
      .post('/api/v1/organizations')
      .set('idempotency-key', randomUUID())
      .send({ name: 'Unauthenticated Organization', slug });
    const nonAdminCreate = await userRequest(
      await tenantToken(randomUUID()),
      'post',
      '/api/v1/organizations',
    )
      .set('idempotency-key', randomUUID())
      .send({ name: 'Non Admin Organization', slug: uniqueSlug('non-admin') });

    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.body.code).toBe('AUTH_MISSING_TOKEN');
    expect(nonAdminCreate.status).toBe(403);
    expect(nonAdminCreate.body.code).toBe('ORG_FORBIDDEN');
  });

  it('supports filtering, sorting, and pagination together', async () => {
    const prefix = `live-page-${randomUUID().slice(0, 8)}`;
    for (const [index, name] of ['Alpha', 'Bravo', 'Charlie'].entries()) {
      const slug = `${prefix}-${name.toLowerCase()}`;
      createdSlugs.push(slug);
      const created = await adminRequest('post', '/api/v1/organizations')
        .set('idempotency-key', randomUUID())
        .send({ name: `${prefix} ${name}`, slug });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      if (index === 1) {
        await adminRequest('patch', `/api/v1/organizations/${created.body.id}/status`).send({
          status: 'SUSPENDED',
        });
      }
    }

    const firstPage = await adminRequest(
      'get',
      `/api/v1/organizations?name=${prefix}&page=0&size=2&sort=name,asc`,
    );
    const secondPage = await adminRequest(
      'get',
      `/api/v1/organizations?name=${prefix}&page=1&size=2&sort=name,asc`,
    );
    const filtered = await adminRequest(
      'get',
      `/api/v1/organizations?name=${prefix}&status=SUSPENDED`,
    );
    const empty = await adminRequest(
      'get',
      `/api/v1/organizations?name=${prefix}&status=ACTIVE&size=1&sort=slug,desc&page=9`,
    );

    expect(firstPage.body).toMatchObject({ page: 0, size: 2, totalElements: 3, totalPages: 2 });
    expect(firstPage.body.content.map((item: { name: string }) => item.name)).toEqual([
      `${prefix} Alpha`,
      `${prefix} Bravo`,
    ]);
    expect(secondPage.body.content).toHaveLength(1);
    expect(filtered.body.content).toHaveLength(1);
    expect(filtered.body.content[0].status).toBe('SUSPENDED');
    expect(empty.body).toMatchObject({ page: 9, size: 1, totalElements: 2, totalPages: 2 });
    expect(empty.body.content).toHaveLength(0);
  });

  it('validates pagination, sorting, uuid, and status inputs', async () => {
    const invalidPage = await adminRequest('get', '/api/v1/organizations?page=-1');
    const invalidSize = await adminRequest('get', '/api/v1/organizations?size=1000');
    const invalidSort = await adminRequest('get', '/api/v1/organizations?sort=password,asc');
    const malformedId = await adminRequest('get', '/api/v1/organizations/not-a-uuid');
    const unknownId = await adminRequest('get', `/api/v1/organizations/${randomUUID()}`);
    const invalidStatus = await adminRequest(
      'patch',
      `/api/v1/organizations/${randomUUID()}/status`,
    ).send({ status: 'DELETED' });

    expect(invalidPage.status).toBe(400);
    expect(invalidSize.status).toBe(400);
    expect(invalidSort.status).toBe(400);
    expect(malformedId.status).toBe(400);
    expect(malformedId.body.code).toBe('ORG_VALIDATION_ERROR');
    expect(malformedId.body.errors[0].field).toBe('id');
    expect(unknownId.status).toBe(404);
    expect(unknownId.body.code).toBe('ORG_NOT_FOUND');
    expect(invalidStatus.status).toBe(400);
    expect(invalidStatus.body.code).toBe('ORG_INVALID_STATUS');
  });

  it('serves internal id and slug lookups to authenticated services', async () => {
    const slug = uniqueSlug('internal');
    const created = await adminRequest('post', '/api/v1/organizations')
      .set('idempotency-key', randomUUID())
      .send({ name: 'Internal Live Organization', slug });
    const id = created.body.id as string;

    const byId = await internalRequest('get', `/internal/v1/organizations/${id}`);
    const bySlug = await internalRequest('get', `/internal/v1/organizations/by-slug/${slug}`);

    expect(byId.status, JSON.stringify(byId.body)).toBe(200);
    expect(byId.body).toEqual({ id, name: 'Internal Live Organization', slug, status: 'ACTIVE' });
    expect(byId.body.createdAt).toBeUndefined();
    expect(bySlug.status).toBe(200);
    expect(bySlug.body.id).toBe(id);
  });

  it('returns suspended tenants to internal callers instead of hiding them', async () => {
    const slug = uniqueSlug('internal-suspended');
    const created = await adminRequest('post', '/api/v1/organizations')
      .set('idempotency-key', randomUUID())
      .send({ name: 'Suspended Internal Organization', slug });
    await adminRequest('patch', `/api/v1/organizations/${created.body.id}/status`).send({
      status: 'SUSPENDED',
    });

    const bySlug = await internalRequest('get', `/internal/v1/organizations/by-slug/${slug}`);

    expect(bySlug.status).toBe(200);
    expect(bySlug.body.status).toBe('SUSPENDED');
  });

  it('rejects unauthenticated, tampered, expired, replayed, and unknown-service internal requests', async () => {
    const slug = uniqueSlug('internal-negative');
    const created = await adminRequest('post', '/api/v1/organizations')
      .set('idempotency-key', randomUUID())
      .send({ name: 'Internal Negative Organization', slug });
    const id = created.body.id as string;
    const path = `/internal/v1/organizations/${id}`;

    const missing = await request(app).get(path);
    const wrongSecret = await internalRequest('get', path, {
      secret: 'a-different-secret-that-is-32-chars-long',
    });
    const unknownService = await internalRequest('get', path, { service: 'case-service' });
    const expired = await internalRequest('get', path, {
      timestamp: String(Math.floor(Date.now() / 1000) - 10_000),
    });
    // Signature generated for a different path than the one requested.
    const tamperedPath = await (async () => {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', internalSecret)
        .update(`user-service:${timestamp}:GET:/internal/v1/organizations/by-slug/other`)
        .digest('hex');
      return request(app).get(path).set({
        'x-internal-service': 'user-service',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': signature,
      });
    })();
    const replayTimestamp = String(Math.floor(Date.now() / 1000));
    const replayedFirst = await internalRequest(
      'get',
      `/internal/v1/organizations/by-slug/${slug}`,
      { timestamp: replayTimestamp },
    );
    const replayed = await internalRequest('get', `/internal/v1/organizations/by-slug/${slug}`, {
      timestamp: replayTimestamp,
    });

    expect(missing.status).toBe(401);
    expect(wrongSecret.status).toBe(401);
    expect(unknownService.status).toBe(401);
    expect(expired.status).toBe(401);
    expect(tamperedPath.status).toBe(401);
    expect(replayedFirst.status).toBe(200);
    // The byte-identical request is a replay inside the skew window.
    expect(replayed.status).toBe(401);
  });

  it('validates internal identifiers and reports unknown organizations', async () => {
    const malformed = await internalRequest('get', '/internal/v1/organizations/not-a-uuid');
    const unknownId = await internalRequest('get', `/internal/v1/organizations/${randomUUID()}`);
    const unknownSlug = await internalRequest(
      'get',
      '/internal/v1/organizations/by-slug/no-such-organization',
    );

    expect(malformed.status).toBe(400);
    expect(unknownId.status).toBe(404);
    expect(unknownId.body.code).toBe('ORG_NOT_FOUND');
    expect(unknownSlug.status).toBe(404);
    expect(unknownSlug.body.code).toBe('ORG_NOT_FOUND');
  });
});
