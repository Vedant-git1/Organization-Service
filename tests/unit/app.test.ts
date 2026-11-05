import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { loadConfig } from '../../src/config/env.js';

const config = loadConfig({
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'mysql://test:test@localhost:3307/resolve_organization',
  REDIS_URL: 'redis://localhost:6379',
  SERVICE_NAME: 'organization-service-test',
  LOG_LEVEL: 'silent',
});

describe('application health endpoints', () => {
  it('initializes and reports process health', async () => {
    const app = createApp(config, {
      checkDatabase: async () => undefined,
      checkRedis: async () => undefined,
    });

    const response = await request(app)
      .get('/health')
      .set('x-request-id', 'test-request-id')
      .set('x-trace-id', 'test-trace-id');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'organization-service-test',
      requestId: 'test-request-id',
    });
    expect(response.body.timestamp).toEqual(expect.any(String));
    expect(response.headers['x-request-id']).toBe('test-request-id');
    expect(response.headers['x-trace-id']).toBe('test-trace-id');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
  });

  it('reports readiness when required dependencies are available', async () => {
    const app = createApp(config, {
      checkDatabase: async () => undefined,
      checkRedis: async () => undefined,
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: 'ready',
      checks: { database: 'up', redis: 'up' },
    });
  });

  it('reports dependency failure as unavailable', async () => {
    const app = createApp(config, {
      checkDatabase: async () => {
        throw new Error('database unavailable');
      },
      checkRedis: async () => undefined,
    });

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      status: 'not_ready',
      checks: { database: 'down', redis: 'up' },
    });
  });

  it('returns correlated structured errors without exposing internals', async () => {
    const app = createApp(config, {
      checkDatabase: async () => undefined,
      checkRedis: async () => undefined,
    });

    const response = await request(app)
      .get('/api/v1/organizations')
      .set('x-request-id', 'error-request-id')
      .set('traceparent', '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({
      status: 401,
      code: 'AUTH_MISSING_TOKEN',
      path: '/api/v1/organizations',
      requestId: 'error-request-id',
      traceId: '0123456789abcdef0123456789abcdef',
    });
    expect(response.body.timestamp).toEqual(expect.any(String));
    expect(response.body.message).not.toContain('stack');
  });
});

describe('API documentation', () => {
  it('serves the OpenAPI contract and Swagger UI', async () => {
    const app = createApp(config, {
      checkDatabase: async () => undefined,
      checkRedis: async () => undefined,
    });

    const contractResponse = await request(app).get('/docs/openapi.yaml');
    const uiResponse = await request(app).get('/docs/');
    const configResponse = await request(app).get('/docs/swagger-ui-init.js');

    expect(contractResponse.status).toBe(200);
    expect(contractResponse.headers['content-type']).toContain('yaml');
    expect(contractResponse.text).toContain('openapi: 3.0.3');
    expect(contractResponse.text).toContain('/api/v1/organizations');
    expect(uiResponse.status).toBe(200);
    expect(uiResponse.text).toContain('Resolve Organization Service API');
    expect(configResponse.status).toBe(200);
    expect(configResponse.text).toContain('/docs/openapi.yaml');
  });
});
