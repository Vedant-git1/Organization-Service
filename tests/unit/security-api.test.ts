import { createHmac } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createMemoryIdempotencyStore } from '../../src/infrastructure/redis/idempotency.js';
import type { OrganizationRepository } from '../../src/modules/organization/organization.repository.js';
import {
  OrganizationStatus,
  type Organization,
} from '../../src/modules/organization/organization.types.js';
import type { AuthContext, AuthorizationService } from '../../src/security/auth.types.js';
import type { JwtVerifier } from '../../src/security/jwt.js';
import { createHmacInternalAuthService } from '../../src/security/internal-auth.js';
import { loadConfig } from '../../src/config/env.js';

const config = loadConfig({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'mysql://test:test@localhost:3307/resolve_organization',
  REDIS_URL: 'redis://localhost:6379',
  SERVICE_NAME: 'organization-service-test',
  LOG_LEVEL: 'silent',
});

class Repository implements OrganizationRepository {
  private readonly values = new Map<string, Organization>();

  async create(input: { name: string; slug: string }): Promise<Organization> {
    const now = new Date();
    const organization = {
      id: randomUUID(),
      ...input,
      status: OrganizationStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
    };
    this.values.set(organization.id, organization);
    return organization;
  }
  async findById(id: string) {
    return this.values.get(id) ?? null;
  }
  async findBySlug(slug: string) {
    return [...this.values.values()].find((value) => value.slug === slug) ?? null;
  }
  async existsBySlug(slug: string, excludeId?: string) {
    return [...this.values.values()].some((value) => value.slug === slug && value.id !== excludeId);
  }
  async update(id: string, input: { name?: string; slug?: string }) {
    const current = this.values.get(id);
    if (!current) throw new Error('not found');
    const updated = { ...current, ...input, updatedAt: new Date() };
    this.values.set(id, updated);
    return updated;
  }
  async updateStatus(id: string, status: OrganizationStatus) {
    const current = this.values.get(id);
    if (!current) throw new Error('not found');
    const updated = { ...current, status, updatedAt: new Date() };
    this.values.set(id, updated);
    return updated;
  }
  async list(input: {
    page: number;
    size: number;
    sort: {
      field: 'name' | 'slug' | 'status' | 'createdAt' | 'updatedAt';
      direction: 'asc' | 'desc';
    };
    name?: string;
    slug?: string;
    status?: OrganizationStatus;
  }) {
    const values = [...this.values.values()].filter(
      (value) =>
        (!input.name || value.name.includes(input.name)) &&
        (!input.slug || value.slug.includes(input.slug)) &&
        (!input.status || value.status === input.status),
    );
    return {
      items: values.slice((input.page - 1) * input.size, input.page * input.size),
      total: values.length,
      page: input.page,
      size: input.size,
    };
  }
}

const contexts: Record<string, AuthContext> = {
  'user-a': { userId: 'user-a', tenantId: 'tenant-a', tokenId: 'token-a' },
  'user-b': { userId: 'user-b', tenantId: 'tenant-b', tokenId: 'token-b' },
  admin: { userId: 'admin', tenantId: 'system', tokenId: 'token-admin' },
};

function createSecurityApp(repository = new Repository()) {
  const jwtVerifier: JwtVerifier = {
    verify: async (token) => contexts[token] ?? Promise.reject(new Error('invalid')),
  };
  const authorizationService: AuthorizationService = {
    isSystemAdministrator: async (userId) => userId === 'admin',
  };
  const internalAuthService = createHmacInternalAuthService({
    secret: 'internal-secret',
    allowedServices: ['user-service'],
    clock: () => 1_700_000_000_000,
  });
  return createApp(config, {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
    organizationRepository: repository,
    jwtVerifier,
    authorizationService,
    internalAuthService,
    idempotencyStore: createMemoryIdempotencyStore(),
  });
}

function authenticated(
  app: ReturnType<typeof createSecurityApp>,
  token: string,
  method: 'get' | 'post' | 'patch',
  path: string,
) {
  return request(app)[method](path).set('authorization', `Bearer ${token}`);
}

describe('tenant authorization', () => {
  it('isolates tenant reads and updates while allowing administrators', async () => {
    const app = createSecurityApp();
    const created = await authenticated(app, 'admin', 'post', '/api/v1/organizations')
      .set('idempotency-key', 'create-tenant-a')
      .send({ name: 'Tenant A', slug: 'tenant-a' });
    const id = created.body.id;
    const userA = contexts['user-a'];
    if (!userA) throw new Error('test user is not configured');
    userA.tenantId = id;

    const own = await authenticated(app, 'user-a', 'get', `/api/v1/organizations/${id}`);
    const cross = await authenticated(app, 'user-b', 'get', `/api/v1/organizations/${id}`);
    const admin = await authenticated(app, 'admin', 'get', `/api/v1/organizations/${id}`);
    const crossUpdate = await authenticated(
      app,
      'user-b',
      'patch',
      `/api/v1/organizations/${id}`,
    ).send({ name: 'Nope' });
    const userStatus = await authenticated(
      app,
      'user-a',
      'patch',
      `/api/v1/organizations/${id}/status`,
    ).send({ status: 'SUSPENDED' });
    const adminStatus = await authenticated(
      app,
      'admin',
      'patch',
      `/api/v1/organizations/${id}/status`,
    ).send({ status: 'SUSPENDED' });

    expect(created.status).toBe(201);
    expect(own.status).toBe(200);
    expect(cross.status).toBe(403);
    expect(admin.status).toBe(200);
    expect(crossUpdate.status).toBe(403);
    expect(userStatus.status).toBe(403);
    expect(adminStatus.status).toBe(200);
  });

  it('requires authentication and administrator access for administrative operations', async () => {
    const app = createSecurityApp();
    const missing = await request(app).get('/api/v1/organizations');
    const normal = await authenticated(app, 'user-a', 'get', '/api/v1/organizations');
    const normalCreate = await authenticated(app, 'user-a', 'post', '/api/v1/organizations')
      .set('idempotency-key', 'normal-create')
      .send({ name: 'Nope', slug: 'nope' });

    expect(missing.status).toBe(401);
    expect(normal.status).toBe(403);
    expect(normalCreate.status).toBe(403);
  });
});

describe('internal organization APIs', () => {
  it('supports authenticated ID and slug lookup', async () => {
    const app = createSecurityApp();
    const created = await authenticated(app, 'admin', 'post', '/api/v1/organizations')
      .set('idempotency-key', 'internal-create')
      .send({ name: 'Internal Org', slug: 'internal-org' });
    const timestamp = '1700000000';
    const sign = (path: string) =>
      createHmac('sha256', 'internal-secret')
        .update(`user-service:${timestamp}:GET:${path}`)
        .digest('hex');
    const byId = await request(app)
      .get(`/internal/v1/organizations/${created.body.id}`)
      .set({
        'x-internal-service': 'user-service',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': sign(`/internal/v1/organizations/${created.body.id}`),
      });
    const bySlug = await request(app)
      .get('/internal/v1/organizations/by-slug/internal-org')
      .set({
        'x-internal-service': 'user-service',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': sign('/internal/v1/organizations/by-slug/internal-org'),
      });
    const invalid = await request(app)
      .get('/internal/v1/organizations/not-an-id')
      .set({
        'x-internal-service': 'user-service',
        'x-internal-timestamp': timestamp,
        'x-internal-signature': sign('/internal/v1/organizations/not-an-id'),
      });

    expect(byId.status).toBe(200);
    expect(bySlug.status).toBe(200);
    expect(invalid.status).toBe(400);
  });
});
