import { describe, expect, it } from 'vitest';
import { AppError } from '../../src/shared/errors.js';
import { OrganizationService } from '../../src/modules/organization/organization.service.js';
import type { OrganizationRepository } from '../../src/modules/organization/organization.repository.js';
import {
  OrganizationStatus,
  type Organization,
} from '../../src/modules/organization/organization.types.js';

function organization(overrides: Partial<Organization> = {}): Organization {
  const now = new Date();
  return {
    id: 'b7d6a7e2-91a9-4d4a-9a5a-5d9f8325c1b0',
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
    list: async () => ({ items: [current], total: 1, page: 1, size: 20 }),
    ...overrides,
  };
}

describe('OrganizationService', () => {
  it('returns a not-found error for unknown organizations', async () => {
    const service = new OrganizationService(repository({ findById: async () => null }));

    await expect(service.getOrganization('missing-id')).rejects.toMatchObject({
      statusCode: 404,
      code: 'ORG_NOT_FOUND',
    });
  });

  it('maps repository uniqueness failures to a slug conflict', async () => {
    const service = new OrganizationService(
      repository({
        existsBySlug: async () => true,
      }),
    );

    await expect(service.createOrganization({ name: 'Acme', slug: 'acme' })).rejects.toEqual(
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
    const service = new OrganizationService(repository({ list }));

    await expect(
      service.listOrganizations({
        page: 2,
        size: 10,
        status: OrganizationStatus.SUSPENDED,
        sort: { field: 'name', direction: 'asc' },
      }),
    ).resolves.toMatchObject({ page: 2, size: 10, total: 0 });
  });
});
