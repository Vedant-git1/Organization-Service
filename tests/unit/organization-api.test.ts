import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { OrganizationRepository } from '../../src/modules/organization/organization.repository.js';
import {
  OrganizationStatus,
  type Organization,
  type OrganizationListResult,
} from '../../src/modules/organization/organization.types.js';
import { loadConfig } from '../../src/config/env.js';
import type { AuthContext, AuthorizationService } from '../../src/security/auth.types.js';
import type { JwtVerifier } from '../../src/security/jwt.js';

const config = loadConfig({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'mysql://test:test@localhost:3307/resolve_organization',
  REDIS_URL: 'redis://localhost:6379',
  SERVICE_NAME: 'organization-service-test',
  LOG_LEVEL: 'silent',
});

class InMemoryOrganizationRepository implements OrganizationRepository {
  private readonly organizations = new Map<string, Organization>();

  async create(input: { name: string; slug: string }): Promise<Organization> {
    if (await this.existsBySlug(input.slug)) {
      // Mirrors the MySQL unique constraint surfaced by Prisma as P2002.
      throw Object.assign(new Error('unique slug constraint'), { code: 'P2002' });
    }
    const now = new Date();
    const organization: Organization = {
      id: randomUUID(),
      name: input.name,
      slug: input.slug,
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
    if (input.slug && (await this.existsBySlug(input.slug, id)))
      throw Object.assign(new Error('unique slug constraint'), { code: 'P2002' });
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
    name?: string;
    slug?: string;
    status?: OrganizationStatus;
    sort: {
      field: 'name' | 'slug' | 'status' | 'createdAt' | 'updatedAt';
      direction: 'asc' | 'desc';
    };
  }): Promise<OrganizationListResult> {
    const filtered = [...this.organizations.values()].filter(
      (organization) =>
        (!input.name || organization.name.includes(input.name)) &&
        (!input.slug || organization.slug.includes(input.slug)) &&
        (!input.status || organization.status === input.status),
    );
    const direction = input.sort.direction === 'asc' ? 1 : -1;
    filtered.sort(
      (left, right) =>
        String(left[input.sort.field]).localeCompare(String(right[input.sort.field])) * direction,
    );
    const start = input.page * input.size;
    return {
      items: filtered.slice(start, start + input.size),
      total: filtered.length,
      page: input.page,
      size: input.size,
    };
  }
}

function createTestApp(repository = new InMemoryOrganizationRepository()) {
  const auth: AuthContext = {
    userId: 'system-admin',
    tenantId: '00000000-0000-0000-0000-000000000001',
    tokenId: 'test-token',
  };
  const jwtVerifier: JwtVerifier = { verify: async () => auth };
  const authorizationService: AuthorizationService = {
    isSystemAdministrator: async (userId) => userId === 'system-admin',
  };
  return createApp(config, {
    checkDatabase: async () => undefined,
    checkRedis: async () => undefined,
    organizationRepository: repository,
    jwtVerifier,
    authorizationService,
  });
}

function apiRequest(
  app: ReturnType<typeof createTestApp>,
  method: 'get' | 'post' | 'patch',
  path: string,
) {
  return request(app)
    [method](path)
    .set('authorization', 'Bearer test-token')
    .set('idempotency-key', randomUUID());
}

describe('organization API', () => {
  it('creates an organization with a server-generated id and timestamps', async () => {
    const response = await apiRequest(createTestApp(), 'post', '/api/v1/organizations').send({
      name: 'Acme Bank',
      slug: 'acme-bank',
    });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ name: 'Acme Bank', slug: 'acme-bank', status: 'ACTIVE' });
    expect(response.body.id).toEqual(expect.any(String));
    expect(response.body.createdAt).toEqual(expect.any(String));
    expect(response.body.updatedAt).toEqual(expect.any(String));
  });

  it('rejects invalid create requests', async () => {
    const app = createTestApp();
    const missingName = await apiRequest(app, 'post', '/api/v1/organizations').send({
      slug: 'acme-bank',
    });
    const blankName = await apiRequest(app, 'post', '/api/v1/organizations').send({
      name: '  ',
      slug: 'acme-bank',
    });
    const invalidSlug = await apiRequest(app, 'post', '/api/v1/organizations').send({
      name: 'Acme',
      slug: 'Acme Bank',
    });

    expect(missingName.status).toBe(400);
    expect(missingName.body.code).toBe('ORG_VALIDATION_ERROR');
    expect(missingName.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'name' })]),
    );
    expect(blankName.status).toBe(400);
    expect(invalidSlug.status).toBe(400);
    expect(invalidSlug.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'slug', code: 'INVALID_FORMAT' })]),
    );
  });

  it('returns a conflict for duplicate slugs, including concurrent attempts', async () => {
    const repository = new InMemoryOrganizationRepository();
    const app = createTestApp(repository);
    const requests = Array.from({ length: 2 }, () =>
      apiRequest(app, 'post', '/api/v1/organizations').send({
        name: 'Acme Bank',
        slug: 'same-slug',
      }),
    );
    const responses = await Promise.all(requests);

    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
  });

  it('gets existing organizations and rejects unknown or malformed ids', async () => {
    const app = createTestApp();
    const created = await apiRequest(app, 'post', '/api/v1/organizations').send({
      name: 'Acme',
      slug: 'acme',
    });
    const found = await apiRequest(app, 'get', `/api/v1/organizations/${created.body.id}`);
    const unknown = await apiRequest(app, 'get', `/api/v1/organizations/${randomUUID()}`);
    const malformed = await apiRequest(app, 'get', '/api/v1/organizations/not-an-id');

    expect(found.status).toBe(200);
    expect(found.body.id).toBe(created.body.id);
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('ORG_NOT_FOUND');
    expect(malformed.status).toBe(400);
  });

  it('updates profile fields but does not allow protected fields through that endpoint', async () => {
    const app = createTestApp();
    const created = await apiRequest(app, 'post', '/api/v1/organizations').send({
      name: 'Acme',
      slug: 'acme',
    });
    const response = await apiRequest(
      app,
      'patch',
      `/api/v1/organizations/${created.body.id}`,
    ).send({ name: 'Acme Updated', slug: 'acme-updated', id: randomUUID(), status: 'SUSPENDED' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: created.body.id,
      name: 'Acme Updated',
      slug: 'acme-updated',
      status: 'ACTIVE',
    });
  });

  it('rejects duplicate slugs during updates and handles status idempotently', async () => {
    const app = createTestApp();
    const first = await apiRequest(app, 'post', '/api/v1/organizations').send({
      name: 'First',
      slug: 'first',
    });
    const second = await apiRequest(app, 'post', '/api/v1/organizations').send({
      name: 'Second',
      slug: 'second',
    });
    const duplicate = await apiRequest(
      app,
      'patch',
      `/api/v1/organizations/${second.body.id}`,
    ).send({ slug: 'first' });
    const suspended = await apiRequest(
      app,
      'patch',
      `/api/v1/organizations/${first.body.id}/status`,
    ).send({ status: 'SUSPENDED' });
    const repeated = await apiRequest(
      app,
      'patch',
      `/api/v1/organizations/${first.body.id}/status`,
    ).send({ status: 'SUSPENDED' });
    const invalid = await apiRequest(
      app,
      'patch',
      `/api/v1/organizations/${first.body.id}/status`,
    ).send({ status: 'UNKNOWN' });

    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('ORG_SLUG_TAKEN');
    expect(suspended.body.status).toBe('SUSPENDED');
    expect(repeated.status).toBe(200);
    expect(repeated.body.status).toBe('SUSPENDED');
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('ORG_INVALID_STATUS');
  });

  it('lists with database-shaped pagination, filters, and sorting', async () => {
    const app = createTestApp();
    await apiRequest(app, 'post', '/api/v1/organizations').send({ name: 'Bravo', slug: 'bravo' });
    const second = await apiRequest(app, 'post', '/api/v1/organizations').send({
      name: 'Alpha',
      slug: 'alpha',
    });
    await apiRequest(app, 'patch', `/api/v1/organizations/${second.body.id}/status`).send({
      status: 'SUSPENDED',
    });

    const response = await apiRequest(
      app,
      'get',
      '/api/v1/organizations?page=0&size=1&name=a&status=SUSPENDED&sort=name:asc',
    );

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body.content).toHaveLength(1);
    expect(response.body.content[0]).toMatchObject({ name: 'Alpha', status: 'SUSPENDED' });
    expect(response.body).toEqual({
      content: [expect.any(Object)],
      page: 0,
      size: 1,
      totalElements: 1,
      totalPages: 1,
    });
  });
});
