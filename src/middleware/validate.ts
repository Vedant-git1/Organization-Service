import type { RequestHandler } from 'express';
import type { ZodType, ZodTypeDef } from 'zod';
import { AppError, toValidationIssues } from '../shared/errors.js';

export function validateRequest<T>(
  location: 'body' | 'params' | 'query',
  schema: ZodType<T, ZodTypeDef, unknown>,
  errorCode = 'ORG_VALIDATION_ERROR',
): RequestHandler {
  return (request, response, next) => {
    const result = schema.safeParse(request[location]);
    if (!result.success) {
      next(
        new AppError(
          400,
          errorCode,
          'Request validation failed',
          toValidationIssues(result.error.issues),
        ),
      );
      return;
    }

    response.locals.validated ??= {};
    response.locals.validated[location] = result.data;
    next();
  };
}
