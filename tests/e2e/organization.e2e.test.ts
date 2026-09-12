import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createMemoryIdempotencyStore } from '../../src/infrastructure/redis/idempotency.js';
import type { OrganizationRepository } from '../../src/modules/organization/organization.repository.js';
import {
  OrganizationStatus,
  type Organization,
  type OrganizationListResult,
} from '../../src/modules/organization/organization.types.js';
import type { AuthContext, AuthorizationService } from '../../src/security/auth.types.js';
import type { JwtVerifier } from '../../src/security/jwt.js';
import { loadConfig } from '../../src/config/env.js';

const config = loadConfig({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'mysql://test:test@localhost:3307/resolve_organization',
  REDIS_URL: 'redis://localhost:6379',
  SERVICE_NAME: 'organization-service-e2e',
  LOG_LEVEL: 'silent',
});

class E2ERepository implements OrganizationRepository {
  private readonly organizations = new Map<string, Organization>();

  async create(input: { name: string; slug: string }): Promise<Organization> {
    if (await this.existsBySlug(input.slug)) {
      const error = new Error('duplicate slug') as Error & { code: string };
      error.code = 'P2002';
      throw error;
    }
    const now = new Date();
    const organization: Organization = {
      id: randomUUID(),
      ...input,
      status: OrganizationStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
    };
    this.organizations.set(organization.id, organization);
    return organization;
  }

  async findById(id: string): Promise<Organization | null> {
    return this.organizations.get(id) ?? null;
  }

  async findBySlug(slug: string): Promise<Organization | null> {
    return (
      [...this.organizations.values()].find((organization) => organization.slug === slug) ?? null
    );
  }

  async existsBySlug(slug: string, excludeId?: string): Promise<boolean> {
    return [...this.organizations.values()].some(
      (organization) => organization.slug === slug && organization.id !== excludeId,
    );
  }

  async update(id: string, input: { name?: string; slug?: string }): Promise<Organization> {
    const organization = await this.findById(id);
    if (!organization) throw new Error('organization not found');
    const updated = { ...organization, ...input, updatedAt: new Date() };
    this.organizations.set(id, updated);
    return updated;
  }

  async updateStatus(id: string, status: OrganizationStatus): Promise<Organization> {
    const organization = await this.findById(id);
    if (!organization) throw new Error('organization not found');
    const updated = { ...organization, status, updatedAt: new Date() };
    this.organizations.set(id, updated);
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
  }): Promise<OrganizationListResult> {
    const values = [...this.organizations.values()].filter(
      (organization) =>
        (!input.name || organization.name.includes(input.name)) &&
        (!input.slug || organization.slug.includes(input.slug)) &&
        (!input.status || organization.status === input.status),
    );
    const start = (input.page - 1) * input.size;
    return {
      items: values.slice(start, start + input.size),
      total: values.length,
      page: input.page,
      size: input.size,
    };
  }
}

function createE2EApp() {
  const repository = new E2ERepository();
  const contexts: Record<string, AuthContext> = {
    admin: { userId: 'admin', tenantId: 'system', tokenId: 'admin-token' },
  };
  const jwtVerifier: JwtVerifier = {
    verify: async (token) => contexts[token] ?? Promise.reject(new Error('invalid')),
  };
  const authorization: AuthorizationService = {
    isSystemAdministrator: async (userId) => userId === 'admin',
  };

  return createApp(config, {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
    organizationRepository: repository,
    jwtVerifier,
    authorizationService: authorization,
    idempotencyStore: createMemoryIdempotencyStore(),
  });
}

function adminRequest(
  app: ReturnType<typeof createE2EApp>,
  method: 'get' | 'post' | 'patch',
  path: string,
) {
  return request(app)
    [method](path)
    .set('authorization', 'Bearer admin')
    .set('idempotency-key', randomUUID());
}

describe('organization lifecycle e2e', () => {
  it('creates, gets, lists, updates, suspends, and reactivates an organization', async () => {
    const app = createE2EApp();
    const created = await adminRequest(app, 'post', '/api/v1/organizations').send({
      name: 'Lifecycle Organization',
      slug: 'lifecycle-organization',
    });
    const id = created.body.id as string;

    const found = await adminRequest(app, 'get', `/api/v1/organizations/${id}`);
    const listed = await adminRequest(app, 'get', '/api/v1/organizations?page=1&size=20');
    const updated = await adminRequest(app, 'patch', `/api/v1/organizations/${id}`).send({
      name: 'Updated Lifecycle Organization',
    });
    const suspended = await adminRequest(app, 'patch', `/api/v1/organizations/${id}/status`).send({
      status: 'SUSPENDED',
    });
    const active = await adminRequest(app, 'patch', `/api/v1/organizations/${id}/status`).send({
      status: 'ACTIVE',
    });

    expect(created.status).toBe(201);
    expect(found.status).toBe(200);
    expect(listed.status).toBe(200);
    expect(listed.body.content).toHaveLength(1);
    expect(updated.body.name).toBe('Updated Lifecycle Organization');
    expect(suspended.body.status).toBe('SUSPENDED');
    expect(active.body.status).toBe('ACTIVE');
  });

  it('replays idempotent creation and rejects a different body for the same key', async () => {
    const app = createE2EApp();
    const key = 'e2e-idempotency-key';
    const first = await request(app)
      .post('/api/v1/organizations')
      .set('authorization', 'Bearer admin')
      .set('idempotency-key', key)
      .send({ name: 'Idempotent Organization', slug: 'idempotent-organization' });
    const retry = await request(app)
      .post('/api/v1/organizations')
      .set('authorization', 'Bearer admin')
      .set('idempotency-key', key)
      .send({ name: 'Idempotent Organization', slug: 'idempotent-organization' });
    const conflict = await request(app)
      .post('/api/v1/organizations')
      .set('authorization', 'Bearer admin')
      .set('idempotency-key', key)
      .send({ name: 'Different Organization', slug: 'different-organization' });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(conflict.status).toBe(409);
  });
});
