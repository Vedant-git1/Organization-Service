import type { RequestHandler } from 'express';
import type { InternalOrganizationService } from './organization.service.js';
import type { Organization } from './organization.types.js';
import type { OrganizationIdParams } from './organization.schemas.js';

/**
 * Internal lookups return the canonical summary shape `{ id, name, slug,
 * status }` (Organization contract §3.3/§3.4, Authentication contract §14.0) —
 * not the public representation, which also carries the timestamps.
 */
function toInternalResponse(organization: Organization) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
  };
}

/**
 * Service-to-service controller. It depends on `InternalOrganizationService`,
 * which has no tenant actor: reachability is gated exclusively by
 * `authenticateInternalService` on the route.
 */
export function createInternalOrganizationController(service: InternalOrganizationService): {
  getById: RequestHandler;
  getBySlug: RequestHandler;
} {
  return {
    getById: async (_request, response) => {
      const { id } = response.locals.validated.params as OrganizationIdParams;
      const organization = await service.getById(id);
      response.status(200).json(toInternalResponse(organization));
    },
    getBySlug: async (_request, response) => {
      const { slug } = response.locals.validated.params as { slug: string };
      const organization = await service.getBySlug(slug);
      response.status(200).json(toInternalResponse(organization));
    },
  };
}
