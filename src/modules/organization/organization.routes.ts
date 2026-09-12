import { Router } from 'express';
import type { OrganizationRepository } from './organization.repository.js';
import {
  createOrganizationController,
  createSecuredOrganizationController,
} from './organization.controller.js';
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

export function createOrganizationRouter(
  repository: OrganizationRepository,
  verifier: JwtVerifier,
  authorization: AuthorizationService,
  idempotency: IdempotencyStore,
): Router {
  const router = Router();
  // One service instance shared by both controller variants (DI cleanup).
  const service = new OrganizationService(repository);
  const controller = createOrganizationController(service);
  const securedController = createSecuredOrganizationController(
    service,
    authorization,
    idempotency,
  );
  const authenticated = authenticate(verifier);

  router.post(
    '/',
    authenticated,
    requireSystemAdministrator(authorization),
    requireIdempotencyKey,
    validateRequest('body', createOrganizationRequestSchema),
    securedController.create,
  );
  router.get(
    '/',
    authenticated,
    requireSystemAdministrator(authorization),
    validateRequest('query', listOrganizationsQuerySchema),
    controller.list,
  );
  router.get(
    '/:id',
    authenticated,
    validateRequest('params', organizationIdParamsSchema),
    securedController.get,
  );
  router.patch(
    '/:id/status',
    authenticated,
    requireSystemAdministrator(authorization),
    validateRequest('params', organizationIdParamsSchema),
    validateRequest('body', updateOrganizationStatusRequestSchema, 'ORG_INVALID_STATUS'),
    controller.updateStatus,
  );
  // System Administrator only (Organization contract §1 authorization model
  // and §3.2): only GET /{id} additionally accepts an org member.
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
