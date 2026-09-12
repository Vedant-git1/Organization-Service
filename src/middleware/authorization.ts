import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors.js';
import type { AuthorizationService } from '../security/auth.types.js';

/**
 * System Administrator gate (Organization contract §1). Only `GET
 * /api/v1/organizations/{id}` also accepts a caller who is simply a member of
 * the requested org; every other public endpoint is System Administrator only.
 * Canonical error code: `ORG_FORBIDDEN`.
 */
export function requireSystemAdministrator(authorization: AuthorizationService): RequestHandler {
  return async (_request, response, next) => {
    const auth = response.locals.auth;
    if (!auth) {
      next(new AppError(401, 'AUTH_MISSING_TOKEN', 'Authentication is required'));
      return;
    }

    try {
      if (!(await authorization.isSystemAdministrator(auth.userId))) {
        next(
          new AppError(
            403,
            'ORG_FORBIDDEN',
            'Only System Administrators may perform this operation',
          ),
        );
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
