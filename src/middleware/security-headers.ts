import type { RequestHandler } from 'express';
import type { AppConfig } from '../config/env.js';

export const securityHeaders = (environment: AppConfig['NODE_ENV']): RequestHandler => {
  return (_request, response, next) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');
    if (environment === 'production') {
      response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
};
