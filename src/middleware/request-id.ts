import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export const requestIdMiddleware: RequestHandler = (request, response, next) => {
  const requestId = request.header('x-request-id') ?? randomUUID();
  response.locals.requestId = requestId;
  response.setHeader('x-request-id', requestId);
  const traceparent = request.header('traceparent');
  const traceparentId = traceparent?.split('-')[1];
  const traceId =
    request.header('x-trace-id') ??
    (traceparentId && /^[0-9a-f]{32}$/i.test(traceparentId) ? traceparentId : undefined) ??
    randomUUID();
  response.locals.traceId = traceId;
  response.setHeader('x-trace-id', traceId);
  next();
};
