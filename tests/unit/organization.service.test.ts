import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import {
  InternalOrganizationService,
  OrganizationService,
} from '../../src/modules/organization/organization.service.js';
import type { OrganizationRepository } from '../../src/modules/organization/organization.repository.js';
import {
  OrganizationStatus,
  type Organization,
} from '../../src/modules/organization/organization.types.js';
import type { AuthContext, AuthorizationService } from '../../src/security/auth.types.js';

const organizationId = 'b7d6a7e2-91a9-4d4a-9a5a-5d9f8325c1b0';

function organization(overrides: Partial<Organization> = {}): Organization {
  const now = new Date();
  return {
    id: organizationId,
    name: 'Acme',
    slug: 'acme',
    status: OrganizationStatus.ACTIVE,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function repository(overrides: Partial<OrganizationRepository> = {}): OrganizationRepository {
  const current = organization();
  return {
    create: async () => current,
    findById: async () => current,
    findBySlug: async () => null,
    existsBySlug: async () => false,
    update: async (_id, input) => organization({ ...current, ...input }),
    updateStatus: async (_id, status) => organization({ ...current, status }),
    list: async () => ({ items: [current], total: 1, page: 0, size: 20 }),
    ...overrides,
  };
}

/** System Administrator adapter double; anyone else is a normal tenant user. */
function authorization(administratorIds: string[] = ['admin']): AuthorizationService {
  const administrators = new Set(administratorIds);
  return { isSystemAdministrator: async (userId) => administrators.has(userId) };
}

const admin: AuthContext = { userId: 'admin', tenantId: 'system', tokenId: 'admin-token' };
const tenantUser: AuthContext = { userId: 'user-a', tenantId: organizationId, tokenId: 'token-a' };

describe('OrganizationService (public, tenant-scoped)', () => {
  it('returns a not-found error for unknown organizations', async () => {
    const service = new OrganizationService(
      repository({ findById: async () => null }),
      authorization(),
    );

    await expect(service.getOrganization(organizationId, admin)).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORG_NOT_FOUND',
    });
  });

  it('maps repository uniqueness failures to a slug conflict', async () => {
    const service = new OrganizationService(
      repository({ existsBySlug: async () => true }),
      authorization(),
    );

    await expect(service.createOrganization({ name: 'Acme', slug: 'acme' }, admin)).rejects.toEqual(
      new AppError(409, 'ORG_SLUG_TAKEN', 'Organization slug is already in use'),
    );
  });

  it('delegates list pagination and filters to the repository', async () => {
    const list = async (input: Parameters<OrganizationRepository['list']>[0]) => ({
      items: [],
      total: input.status === OrganizationStatus.SUSPENDED ? 0 : 1,
      page: input.page,
      size: input.size,
    });
    const service = new OrganizationService(repository({ list }), authorization());

    await expect(
      service.listOrganizations(
        {
          page: 2,
          size: 10,
          status: OrganizationStatus.SUSPENDED,
          sort: { field: 'name', direction: 'asc' },
        },
        admin,
      ),
    ).resolves.toMatchObject({ page: 2, size: 10, total: 0 });
  });

  it('rejects non-Administrators from every administrative operation', async () => {
    const service = new OrganizationService(repository(), authorization());

    await expect(
      service.createOrganization({ name: 'Acme', slug: 'acme' }, tenantUser),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ORG_FORBIDDEN' });
    await expect(
      service.listOrganizations(
        { page: 0, size: 20, sort: { field: 'name', direction: 'asc' } },
        tenantUser,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ORG_FORBIDDEN' });
    await expect(
      service.updateOrganization(organizationId, { name: 'Nope' }, tenantUser),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ORG_FORBIDDEN' });
    await expect(
      service.updateOrganizationStatus(organizationId, OrganizationStatus.SUSPENDED, tenantUser),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ORG_FORBIDDEN' });
  });

  it('enforces tenant isolation on reads (FR-TEN-04)', async () => {
    const service = new OrganizationService(repository(), authorization());

    await expect(service.getOrganization(organizationId, tenantUser)).resolves.toMatchObject({
      id: organizationId,
    });
    await expect(
      service.getOrganization(organizationId, {
        userId: 'user-b',
        tenantId: 'a-different-tenant',
        tokenId: 'token-b',
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: 'ORG_FORBIDDEN' });
    await expect(service.getOrganization(organizationId, admin)).resolves.toMatchObject({
      id: organizationId,
    });
  });
});

describe('InternalOrganizationService (service-to-service)', () => {
  it('looks organizations up by id and slug', async () => {
    const service = new InternalOrganizationService(
      repository({ findBySlug: async () => organization() }),
    );

    await expect(service.getById(organizationId)).resolves.toMatchObject({ id: organizationId });
    await expect(service.getBySlug('acme')).resolves.toMatchObject({ slug: 'acme' });
  });

  it('returns suspended tenants so callers can apply their own rejection policy', async () => {
    const service = new InternalOrganizationService(
      repository({
        findBySlug: async () => organization({ status: OrganizationStatus.SUSPENDED }),
      }),
    );

    await expect(service.getBySlug('acme')).resolves.toMatchObject({
      status: OrganizationStatus.SUSPENDED,
    });
  });

  it('returns not-found for unknown ids and slugs', async () => {
    const service = new InternalOrganizationService(
      repository({ findById: async () => null, findBySlug: async () => null }),
    );

    await expect(service.getById(organizationId)).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORG_NOT_FOUND',
    });
    await expect(service.getBySlug('missing')).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORG_NOT_FOUND',
    });
  });
});
