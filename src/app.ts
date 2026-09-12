import express, { type Express } from 'express';
import pinoHttp from 'pino-http';
import type { AppConfig } from './config/env.js';
import {
  createHealthRouter,
  type HealthDependencies,
} from './modules/organization/health.routes.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { errorHandler } from './shared/errors.js';
import { createLogger } from './shared/logger.js';
import { prisma } from './infrastructure/database/prisma.js';
import {
  createOrganizationRepository,
  type OrganizationRepository,
} from './modules/organization/organization.repository.js';
import { createOrganizationRouter } from './modules/organization/organization.routes.js';
import { createInternalOrganizationRouter } from './modules/organization/internal.routes.js';
import type { JwtVerifier } from './security/jwt.js';
import type { AuthorizationService, InternalAuthService } from './security/auth.types.js';
import {
  createMemoryIdempotencyStore,
  type IdempotencyStore,
} from './infrastructure/redis/idempotency.js';
import { AppError } from './shared/errors.js';
import { securityHeaders } from './middleware/security-headers.js';

export interface AppDependencies extends HealthDependencies {
  organizationRepository?: OrganizationRepository;
  jwtVerifier?: JwtVerifier;
  authorizationService?: AuthorizationService;
  internalAuthService?: InternalAuthService;
  idempotencyStore?: IdempotencyStore;
}

const unavailableJwtVerifier: JwtVerifier = {
  async verify() {
    throw new AppError(401, 'AUTH_INVALID_TOKEN', 'Authentication is not configured');
  },
};

const unavailableAuthorizationService: AuthorizationService = {
  async isSystemAdministrator() {
    return false;
  },
};

const unavailableInternalAuthService: InternalAuthService = {
  async authenticate() {
    throw new AppError(401, 'INTERNAL_AUTH_INVALID', 'Internal authentication is not configured');
  },
};

export function createApp(config: AppConfig, dependencies: AppDependencies): Express {
  const app = express();
  const logger = createLogger(config);
  const repository = dependencies.organizationRepository ?? createOrganizationRepository(prisma);
  const jwtVerifier = dependencies.jwtVerifier ?? unavailableJwtVerifier;
  const authorization = dependencies.authorizationService ?? unavailableAuthorizationService;
  const internalAuth = dependencies.internalAuthService ?? unavailableInternalAuthService;
  if (!dependencies.idempotencyStore && config.NODE_ENV !== 'test') {
    throw new Error('Idempotency storage is required outside test environments');
  }
  const idempotency = dependencies.idempotencyStore ?? createMemoryIdempotencyStore();

  app.disable('x-powered-by');
  app.use(securityHeaders(config.NODE_ENV));
  app.use(requestIdMiddleware);
  app.use(
    pinoHttp({
      logger,
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers.x-internal-signature',
      ],
      genReqId: (_request, response) => response.locals.requestId as string,
      customProps: (_request, response) => ({
        requestId: response.locals.requestId,
        traceId: response.locals.traceId,
      }),
    }),
  );
  app.use(express.json());
  app.use(createHealthRouter(config, dependencies));
  app.use(
    '/api/v1/organizations',
    createOrganizationRouter(repository, jwtVerifier, authorization, idempotency),
  );
  app.use('/internal/v1/organizations', createInternalOrganizationRouter(repository, internalAuth));
  app.use(errorHandler);

  return app;
}
