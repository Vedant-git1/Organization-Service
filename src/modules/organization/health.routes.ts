import { Router } from 'express';
import type { AppConfig } from '../../config/env.js';

export interface HealthDependencies {
  checkDatabase: () => Promise<void>;
  checkRedis: () => Promise<void>;
}

export function createHealthRouter(config: AppConfig, dependencies: HealthDependencies): Router {
  const router = Router();

  router.get('/health', (_request, response) => {
    response.status(200).json({
      status: 'ok',
      service: config.SERVICE_NAME,
      timestamp: new Date().toISOString(),
      requestId: response.locals.requestId,
    });
  });

  router.get('/health/ready', async (_request, response) => {
    const checks = await Promise.allSettled([
      dependencies.checkDatabase(),
      dependencies.checkRedis(),
    ]);
    const databaseReady = checks[0]?.status === 'fulfilled';
    const redisReady = checks[1]?.status === 'fulfilled';
    const ready = databaseReady && redisReady;

    response.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      service: config.SERVICE_NAME,
      checks: { database: databaseReady ? 'up' : 'down', redis: redisReady ? 'up' : 'down' },
      requestId: response.locals.requestId,
    });
  });

  return router;
}
