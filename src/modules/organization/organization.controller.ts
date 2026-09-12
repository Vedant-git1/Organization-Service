import type { RequestHandler } from 'express';
import type { OrganizationService } from './organization.service.js';
import type { Organization } from './organization.types.js';
import type { AuthorizationService } from '../../security/auth.types.js';
import type { IdempotencyStore } from '../../infrastructure/redis/idempotency.js';
import type {
  CreateOrganizationRequest,
  ListOrganizationsQuery,
  OrganizationIdParams,
  UpdateOrganizationRequest,
  UpdateOrganizationStatusRequest,
} from './organization.schemas.js';

function toResponse(organization: Organization) {
  return {
    ...organization,
    createdAt: organization.createdAt.toISOString(),
    updatedAt: organization.updatedAt.toISOString(),
  };
}

/**
 * Internal lookups return the canonical summary shape `{ id, name, slug,
 * status }` (Organization contract §3.3/§3.4, Authentication contract §14.0).
 */
function toInternalResponse(organization: Organization) {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    status: organization.status,
  };
}

export function createOrganizationController(service: OrganizationService): {
  create: RequestHandler;
  get: RequestHandler;
  list: RequestHandler;
  update: RequestHandler;
  updateStatus: RequestHandler;
  internalGet: RequestHandler;
  internalGetBySlug: RequestHandler;
} {
  return {
    create: async (_request, response) => {
      const organization = await service.createOrganization(
        response.locals.validated.body as CreateOrganizationRequest,
      );
      response.status(201).json(toResponse(organization));
    },
    get: async (_request, response) => {
      const { id } = response.locals.validated.params as OrganizationIdParams;
      const organization = await service.getOrganization(id);
      response.status(200).json(toResponse(organization));
    },
    list: async (_request, response) => {
      const result = await service.listOrganizations(
        response.locals.validated.query as ListOrganizationsQuery,
      );
      // Canonical pagination response (Organization contract §1):
      // { content, page, size, totalElements, totalPages }.
      response.status(200).json({
        content: result.items.map(toResponse),
        page: result.page,
        size: result.size,
        totalElements: result.total,
        totalPages: Math.ceil(result.total / result.size),
      });
    },
    update: async (_request, response) => {
      const { id } = response.locals.validated.params as OrganizationIdParams;
      const organization = await service.updateOrganization(
        id,
        response.locals.validated.body as UpdateOrganizationRequest,
      );
      response.status(200).json(toResponse(organization));
    },
    updateStatus: async (_request, response) => {
      const { id } = response.locals.validated.params as OrganizationIdParams;
      const { status } = response.locals.validated.body as UpdateOrganizationStatusRequest;
      const organization = await service.updateOrganizationStatus(id, status);
      response.status(200).json(toResponse(organization));
    },
    internalGet: async (_request, response) => {
      const { id } = response.locals.validated.params as OrganizationIdParams;
      const organization = await service.getOrganization(id);
      response.status(200).json(toInternalResponse(organization));
    },
    internalGetBySlug: async (_request, response) => {
      const { slug } = response.locals.validated.params as { slug: string };
      const organization = await service.getOrganizationBySlug(slug);
      response.status(200).json(toInternalResponse(organization));
    },
  };
}

/**
 * Controller variants that add the tenant-aware authorization boundary:
 * - `get` — System Administrator or member of the requested organization
 *   (Organization contract §2.2). Non-members receive 403 ORG_FORBIDDEN.
 * - `create` — Redis-backed idempotency (same key + same body replays the
 *   original result; same key + different body → 409 IDEMPOTENCY_KEY_REUSED).
 * All other administrative operations are gated at the router layer by
 * `requireSystemAdministrator`.
 */
export function createSecuredOrganizationController(
  service: OrganizationService,
  authorization: AuthorizationService,
  idempotency: IdempotencyStore,
): ReturnType<typeof createOrganizationController> {
  const plain = createOrganizationController(service);
  return {
    ...plain,
    create: async (_request, response) => {
      const input = response.locals.validated.body as CreateOrganizationRequest;
      const key = response.locals.idempotencyKey as string;
      const result = await idempotency.execute(key, input, async () => {
        const organization = await service.createOrganization(input);
        return { statusCode: 201, body: toResponse(organization) };
      });
      response.status(result.statusCode).json(result.body);
    },
    get: async (_request, response) => {
      const { id } = response.locals.validated.params as OrganizationIdParams;
      const organization = await service.getOrganizationForActor(
        id,
        response.locals.auth,
        authorization,
      );
      response.status(200).json(toResponse(organization));
    },
  };
}
