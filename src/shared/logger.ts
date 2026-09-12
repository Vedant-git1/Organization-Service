import pino from 'pino';
import type { AppConfig } from '../config/env.js';

export function createLogger(config: AppConfig) {
  return pino({
    name: config.SERVICE_NAME,
    level: config.LOG_LEVEL,
    base: { serviceName: config.SERVICE_NAME },
    serializers: {
      err: pino.stdSerializers.err,
    },
  });
}
