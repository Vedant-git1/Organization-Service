import type { RequestHandler } from 'express';
import type { InternalAuthService } from '../security/auth.types.js';

/**
 * Service-to-service authentication. The canonical mechanism is mTLS client
 * cert or a signed service-to-service JWT carrying a `service` claim; a local
 * HMAC header scheme is the development fallback (see `security/internal-auth`).
 * The caller's forwarded end-user access token is never treated as internal
 * service identity.
 */
export function authenticateInternalService(service: InternalAuthService): RequestHandler {
  return async (request, response, next) => {
    try {
      response.locals.internalAuth = await service.authenticate({
        serviceName: request.header('x-internal-service'),
        signature: request.header('x-internal-signature'),
        timestamp: request.header('x-internal-timestamp'),
        authorization: request.header('authorization'),
        method: request.method,
        path: request.originalUrl.split('?')[0] ?? request.path,
      });
      next();
    } catch (error) {
      next(error);
    }
  };
}
