import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors.js';
import type { JwtVerifier } from '../security/jwt.js';

/**
 * Bearer access-token authentication (FR-IAM-06). Canonical error code for
 * both a missing and an invalid bearer token is `AUTH_MISSING_TOKEN`
 * (Organization contract §6).
 */
export function authenticate(verifier: JwtVerifier): RequestHandler {
  return async (request, response, next) => {
    const authorization = request.header('authorization');
    if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) {
      next(new AppError(401, 'AUTH_MISSING_TOKEN', 'Authentication is required'));
      return;
    }

    try {
      const token = authorization.slice(7).trim();
      response.locals.auth = await verifier.verify(token);
      next();
    } catch (error) {
      next(
        error instanceof AppError
          ? error
          : new AppError(401, 'AUTH_MISSING_TOKEN', 'Authentication token is invalid'),
      );
    }
  };
}
