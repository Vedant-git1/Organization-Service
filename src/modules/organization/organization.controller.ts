import type { RequestHandler } from 'express';
import type { OrganizationService } from './organization.service.js';
import type { Organization } from './organization.types.js';
import type { AuthContext } from '../../security/auth.types.js';
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
 * Public organization endpoints.
 *
 * Every handler passes the verified caller context into `OrganizationService`,
 * which owns the System Administrator / tenant-membership authorization
 * boundary — controllers never decide access themselves.
 * `create` additionally wraps the operation in Redis-backed idempotency: the
 * same key with the same body replays the original response; the same key with
 * a different body is a 409 IDEMPOTENCY_KEY_REUSED.
 */
export function createOrganizationController(
  service: OrganizationService,
  idempotency: IdempotencyStore,
): {
  create: RequestHandler;
  get: RequestHandler;
  list: RequestHandler;
  update: RequestHandler;
  updateStatus: RequestHandler;
} {
  const actor = (response: { locals: Record<string, unknown> }): AuthContext =>
    response.locals.auth as AuthContext;

  return {
    create: async (_request, response) => {
      const input = response.locals.validated.body as CreateOrganizationRequest;
      const key = response.locals.idempotencyKey as string;
      const result = await idempotency.execute(key, input, async () => {
        const organization = await service.createOrganization(input, actor(response));
        return { statusCode: 201, body: toResponse(organization) };
      });
      response.status(result.statusCode).json(result.body);
    },
    get: async (_request, response) => {
      const { id } = response.locals.validated.params as OrganizationIdParams;
      const organization = await service.getOrganization(id, actor(response));
      response.status(200).json(toResponse(organization));
    },
    list: async (_request, response) => {
      const result = await service.listOrganizations(
        response.locals.validated.query as ListOrganizationsQuery,
        actor(response),
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
        actor(response),
      );
      response.status(200).json(toResponse(organization));
    },
    updateStatus: async (_request, response) => {
      const { id } = response.locals.validated.params as OrganizationIdParams;
      const { status } = response.locals.validated.body as UpdateOrganizationStatusRequest;
      const organization = await service.updateOrganizationStatus(id, status, actor(response));
      response.status(200).json(toResponse(organization));
    },
  };
}
