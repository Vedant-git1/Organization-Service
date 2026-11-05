import { Router } from 'express';
import type { OrganizationRepository } from './organization.repository.js';
import { createOrganizationController } from './organization.controller.js';
import {
  createOrganizationRequestSchema,
  listOrganizationsQuerySchema,
  organizationIdParamsSchema,
  updateOrganizationRequestSchema,
  updateOrganizationStatusRequestSchema,
} from './organization.schemas.js';
import { OrganizationService } from './organization.service.js';
import { validateRequest } from '../../middleware/validate.js';
import type { JwtVerifier } from '../../security/jwt.js';
import type { AuthorizationService } from '../../security/auth.types.js';
import { authenticate } from '../../middleware/authentication.js';
import { requireSystemAdministrator } from '../../middleware/authorization.js';
import { requireIdempotencyKey } from '../../middleware/idempotency.js';
import type { IdempotencyStore } from '../../infrastructure/redis/idempotency.js';

/**
 * Public organization routes.
 *
 * Authorization is enforced twice, deliberately: `requireSystemAdministrator`
 * keeps the canonical 403 precedence ahead of body validation, and
 * `OrganizationService` itself re-checks every operation so the boundary cannot
 * be bypassed by a future endpoint that forgets the middleware.
 */
export function createOrganizationRouter(
  repository: OrganizationRepository,
  verifier: JwtVerifier,
  authorization: AuthorizationService,
  idempotency: IdempotencyStore,
): Router {
  const router = Router();
  const service = new OrganizationService(repository, authorization);
  const controller = createOrganizationController(service, idempotency);
  const authenticated = authenticate(verifier);

  router.post(
    '/',
    authenticated,
    requireSystemAdministrator(authorization),
    requireIdempotencyKey,
    validateRequest('body', createOrganizationRequestSchema),
    controller.create,
  );
  router.get(
    '/',
    authenticated,
    requireSystemAdministrator(authorization),
    validateRequest('query', listOrganizationsQuerySchema),
    controller.list,
  );
  // System Administrator, or a caller whose JWT `tenantId` equals `:id`
  // (Organization contract §1 authorization model and §2.2).
  router.get(
    '/:id',
    authenticated,
    validateRequest('params', organizationIdParamsSchema),
    controller.get,
  );
  router.patch(
    '/:id/status',
    authenticated,
    requireSystemAdministrator(authorization),
    validateRequest('params', organizationIdParamsSchema),
    validateRequest('body', updateOrganizationStatusRequestSchema, 'ORG_INVALID_STATUS'),
    controller.updateStatus,
  );
  router.patch(
    '/:id',
    authenticated,
    requireSystemAdministrator(authorization),
    validateRequest('params', organizationIdParamsSchema),
    validateRequest('body', updateOrganizationRequestSchema),
    controller.update,
  );

  return router;
}
