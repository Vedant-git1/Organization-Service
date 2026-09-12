import { Router } from 'express';
import type { InternalAuthService } from '../../security/auth.types.js';
import { authenticateInternalService } from '../../middleware/internal-authentication.js';
import { validateRequest } from '../../middleware/validate.js';
import { organizationIdParamsSchema, slugParamSchema } from './organization.schemas.js';
import type { OrganizationRepository } from './organization.repository.js';
import { createOrganizationController } from './organization.controller.js';
import { OrganizationService } from './organization.service.js';

/**
 * Service-to-service endpoints (Organization contract §3.3/§3.4). Every route
 * is gated by internal service authentication; the caller's forwarded end-user
 * token is never used as internal identity. Responses use the canonical
 * summary shape `{ id, name, slug, status }`.
 */
export function createInternalOrganizationRouter(
  repository: OrganizationRepository,
  internalAuth: InternalAuthService,
): Router {
  const router = Router();
  const controller = createOrganizationController(new OrganizationService(repository));
  router.use(authenticateInternalService(internalAuth));
  router.get('/:id', validateRequest('params', organizationIdParamsSchema), controller.internalGet);
  router.get(
    '/by-slug/:slug',
    validateRequest('params', slugParamSchema),
    controller.internalGetBySlug,
  );
  return router;
}
