import type { RequestHandler } from 'express';
import { AppError } from '../shared/errors.js';

export const requireIdempotencyKey: RequestHandler = (request, response, next) => {
  const key = request.header('idempotency-key')?.trim();
  if (!key || key.length > 255) {
    next(new AppError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required'));
    return;
  }
  response.locals.idempotencyKey = key;
  next();
};
