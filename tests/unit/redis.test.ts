import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { createRedisClient } from '../../src/infrastructure/redis/client.js';

describe('Redis infrastructure', () => {
  it('creates a client from validated configuration', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      PORT: '3000',
      DATABASE_URL: 'mysql://user:password@localhost:3306/resolve_organization',
      REDIS_URL: 'redis://localhost:6379',
      SERVICE_NAME: 'organization-service',
    });
    const redis = createRedisClient(config);

    expect(redis.options.host).toBe('localhost');
    expect(redis.options.port).toBe(6379);
    await redis.disconnect();
  });
});
