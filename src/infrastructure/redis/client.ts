import Redis from 'ioredis';
import type { AppConfig } from '../../config/env.js';

export function createRedisClient(config: AppConfig): Redis {
  return new Redis(config.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
}

export async function checkRedisHealth(client: Pick<Redis, 'ping'>): Promise<void> {
  await client.ping();
}
