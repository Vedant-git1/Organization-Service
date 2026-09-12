import { z } from 'zod';
import { OrganizationStatus } from './organization.types.js';

const nameSchema = z.string().trim().min(1).max(255);
const slugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must contain lowercase letters, numbers, and hyphens');
const statusSchema = z.enum([OrganizationStatus.ACTIVE, OrganizationStatus.SUSPENDED]);

export const createOrganizationRequestSchema = z.object({
  name: nameSchema,
  slug: slugSchema,
});

export const updateOrganizationRequestSchema = z
  .object({
    name: nameSchema.optional(),
    slug: slugSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.slug !== undefined, {
    message: 'at least one profile field is required',
  });

export const updateOrganizationStatusRequestSchema = z.object({
  status: statusSchema,
});

export const organizationIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const slugParamSchema = z.object({
  slug: slugSchema,
});

const sortSchema = z
  .string()
  .regex(/^(name|slug|status|createdAt|updatedAt)([:,](asc|desc))?$/, 'invalid sort')
  .default('createdAt,desc')
  .transform((value) => {
    const [field, direction = 'asc'] = value.split(/[:,]/);
    return {
      field: field as 'name' | 'slug' | 'status' | 'createdAt' | 'updatedAt',
      direction: direction as 'asc' | 'desc',
    };
  });

export const listOrganizationsQuerySchema = z.object({
  // Canonical pagination is 0-based (Organization contract §1):
  // `?page=0&size=20&sort=createdAt,desc`.
  page: z.coerce.number().int().min(0).default(0),
  size: z.coerce.number().int().min(1).max(100).default(20),
  name: z.string().trim().min(1).optional(),
  slug: z.string().trim().min(1).optional(),
  status: statusSchema.optional(),
  sort: sortSchema,
});

export type CreateOrganizationRequest = z.infer<typeof createOrganizationRequestSchema>;
export type UpdateOrganizationRequest = z.infer<typeof updateOrganizationRequestSchema>;
export type UpdateOrganizationStatusRequest = z.infer<typeof updateOrganizationStatusRequestSchema>;
export type OrganizationIdParams = z.infer<typeof organizationIdParamsSchema>;
export type ListOrganizationsQuery = z.infer<typeof listOrganizationsQuerySchema>;
