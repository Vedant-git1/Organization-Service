import type { Organization as PrismaOrganization, PrismaClient } from '@prisma/client';
import type {
  CreateOrganizationInput,
  ListOrganizationsInput,
  Organization,
  OrganizationListResult,
  OrganizationStatus,
  OrganizationSort,
  UpdateOrganizationInput,
} from './organization.types.js';

export interface OrganizationRepository {
  create(input: CreateOrganizationInput): Promise<Organization>;
  findById(id: string): Promise<Organization | null>;
  findBySlug(slug: string): Promise<Organization | null>;
  existsBySlug(slug: string, excludeId?: string): Promise<boolean>;
  update(id: string, input: UpdateOrganizationInput): Promise<Organization>;
  updateStatus(id: string, status: OrganizationStatus): Promise<Organization>;
  list(input: ListOrganizationsInput): Promise<OrganizationListResult>;
}

function toOrganization(record: PrismaOrganization): Organization {
  return {
    id: record.id,
    name: record.name,
    slug: record.slug,
    status: record.status as OrganizationStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function toOrderBy(sort: OrganizationSort): Record<string, 'asc' | 'desc'> {
  return { [sort.field]: sort.direction };
}

export function createOrganizationRepository(client: PrismaClient): OrganizationRepository {
  return {
    async create(input) {
      const record = await client.organization.create({
        data: { name: input.name, slug: input.slug },
      });
      return toOrganization(record);
    },

    async findById(id) {
      const record = await client.organization.findUnique({ where: { id } });
      return record ? toOrganization(record) : null;
    },

    async findBySlug(slug) {
      const record = await client.organization.findUnique({ where: { slug } });
      return record ? toOrganization(record) : null;
    },

    async existsBySlug(slug, excludeId) {
      const record = await client.organization.findFirst({
        where: { slug, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
        select: { id: true },
      });
      return record !== null;
    },

    async update(id, input) {
      const record = await client.organization.update({ where: { id }, data: input });
      return toOrganization(record);
    },

    async updateStatus(id, status) {
      const record = await client.organization.update({ where: { id }, data: { status } });
      return toOrganization(record);
    },

    async list(input) {
      const where = {
        ...(input.name ? { name: { contains: input.name } } : {}),
        ...(input.slug ? { slug: { contains: input.slug } } : {}),
        ...(input.status ? { status: input.status } : {}),
      };
      const skip = input.page * input.size;
      const [records, total] = await Promise.all([
        client.organization.findMany({
          where,
          skip,
          take: input.size,
          orderBy: toOrderBy(input.sort),
        }),
        client.organization.count({ where }),
      ]);

      return {
        items: records.map(toOrganization),
        total,
        page: input.page,
        size: input.size,
      };
    },
  };
}
