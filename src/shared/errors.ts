import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';

type ZodIssue = ZodError['issues'][number];

/**
 * Canonical field-validation issue (Organization contract §1): present in the
 * `errors[]` array of 400 responses only.
 */
export interface ValidationIssue {
  field: string;
  code: string;
  message: string;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly errors?: ValidationIssue[];

  constructor(statusCode: number, code: string, message: string, errors?: ValidationIssue[]) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.errors = errors;
  }
}

/** Maps a Zod issue code to a canonical-style field-error code. */
function mapIssueCode(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return 'INVALID_TYPE';
    case 'invalid_string':
      return 'INVALID_FORMAT';
    case 'invalid_enum_value':
      return 'INVALID_ENUM_VALUE';
    case 'invalid_literal':
      return 'INVALID_VALUE';
    case 'custom':
      return issue.message.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
    case 'too_small':
    case 'too_big':
      return 'OUT_OF_RANGE';
    default:
      return 'INVALID_VALUE';
  }
}

export function toValidationIssues(issues: readonly ZodIssue[]): ValidationIssue[] {
  return issues.map((issue) => ({
    field: issue.path.join('.') || 'value',
    code: mapIssueCode(issue),
    message: issue.message,
  }));
}

interface CanonicalErrorResponse {
  timestamp: string;
  status: number;
  code: string;
  message: string;
  path: string;
  requestId: string;
  traceId: string;
  errors?: ValidationIssue[];
}

/**
 * Standard error shape per the canonical Organization contract §1:
 * a flat object with `timestamp`, `status`, `code`, `message`, `path`,
 * `requestId`, `traceId`, plus `errors[]` on 400 field-validation failures.
 * Internal details (SQL, Prisma, Redis, stack traces, secrets) are never
 * serialized.
 */
export function errorHandler(
  error: unknown,
  request: Request,
  response: Response,
  _next: NextFunction,
): void {
  const requestId = response.locals.requestId as string;
  const traceId = response.locals.traceId as string;
  const path = request.originalUrl.split('?')[0] ?? request.path;
  const errorResponse = (
    status: number,
    code: string,
    message: string,
    errors?: ValidationIssue[],
  ): CanonicalErrorResponse => ({
    timestamp: new Date().toISOString(),
    status,
    code,
    message,
    path,
    requestId,
    traceId,
    ...(errors ? { errors } : {}),
  });

  if (error instanceof ZodError) {
    request.log.warn(
      { status: 400, errorCode: 'ORG_VALIDATION_ERROR', requestId, traceId },
      'Request validation failed',
    );
    response
      .status(400)
      .json(
        errorResponse(
          400,
          'ORG_VALIDATION_ERROR',
          'Request validation failed',
          toValidationIssues(error.issues),
        ),
      );
    return;
  }

  if (error instanceof AppError) {
    request.log.warn(
      { status: error.statusCode, errorCode: error.code, requestId, traceId },
      'Request rejected',
    );
    response
      .status(error.statusCode)
      .json(errorResponse(error.statusCode, error.code, error.message, error.errors));
    return;
  }

  if (
    error instanceof SyntaxError &&
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    error.status === 400
  ) {
    request.log.warn(
      { status: 400, errorCode: 'ORG_VALIDATION_ERROR', requestId, traceId },
      'Malformed JSON request',
    );
    response
      .status(400)
      .json(errorResponse(400, 'ORG_VALIDATION_ERROR', 'Request body contains invalid JSON'));
    return;
  }

  request.log.error(
    {
      err: error,
      requestId,
      traceId,
      path,
      status: 500,
      errorCode: 'INTERNAL_SERVER_ERROR',
    },
    'Unhandled request error',
  );
  response.status(500).json(errorResponse(500, 'INTERNAL_SERVER_ERROR', 'Internal server error'));
}
