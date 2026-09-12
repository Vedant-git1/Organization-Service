import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import { AppError } from '../../shared/errors.js';

interface StoredIdempotencyResult {
  hash: string;
  state: 'pending' | 'complete';
  statusCode?: number;
  body?: unknown;
}

export interface IdempotencyStore {
  execute<T>(
    key: string,
    input: unknown,
    operation: () => Promise<{ statusCode: number; body: T }>,
  ): Promise<{
    statusCode: number;
    body: T;
  }>;
}

type IdempotencyOperation<T> = () => Promise<{ statusCode: number; body: T }>;

const reservationTtlSeconds = 120;
const resultTtlSeconds = 86400;

function requestHash(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function createRedisIdempotencyStore(
  redis: Pick<Redis, 'set' | 'get' | 'del'>,
): IdempotencyStore {
  return {
    async execute<T>(key: string, input: unknown, operation: IdempotencyOperation<T>) {
      const hash = requestHash(input);
      const redisKey = `idempotency:${key}`;
      const pending: StoredIdempotencyResult = { hash, state: 'pending' };
      const acquired = await redis.set(
        redisKey,
        JSON.stringify(pending),
        'EX',
        reservationTtlSeconds,
        'NX',
      );

      if (acquired !== 'OK') {
        const stored = await redis.get(redisKey);
        const result = stored ? (JSON.parse(stored) as StoredIdempotencyResult) : undefined;
        if (!result || result.hash !== hash) {
          throw new AppError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used with a different request body',
          );
        }
        if (result.state === 'pending') {
          throw new AppError(
            409,
            'IDEMPOTENCY_REQUEST_IN_PROGRESS',
            'A request with this idempotency key is in progress',
          );
        }
        return { statusCode: result.statusCode ?? 200, body: result.body as T };
      }

      try {
        const response = await operation();
        const complete: StoredIdempotencyResult = {
          hash,
          state: 'complete',
          statusCode: response.statusCode,
          body: response.body,
        };
        await redis.set(redisKey, JSON.stringify(complete), 'EX', resultTtlSeconds);
        return response;
      } catch (error) {
        await redis.del(redisKey);
        throw error;
      }
    },
  };
}

export function createMemoryIdempotencyStore(): IdempotencyStore {
  const values = new Map<string, StoredIdempotencyResult>();
  return {
    async execute<T>(key: string, input: unknown, operation: IdempotencyOperation<T>) {
      const hash = requestHash(input);
      const current = values.get(key);
      if (current) {
        if (current.hash !== hash) {
          throw new AppError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency-Key was already used with a different request body',
          );
        }
        if (current.state === 'pending') {
          throw new AppError(
            409,
            'IDEMPOTENCY_REQUEST_IN_PROGRESS',
            'A request with this idempotency key is in progress',
          );
        }
        return { statusCode: current.statusCode ?? 200, body: current.body as T };
      }

      values.set(key, { hash, state: 'pending' });
      try {
        const response = await operation();
        values.set(key, {
          hash,
          state: 'complete',
          statusCode: response.statusCode,
          body: response.body,
        });
        return response;
      } catch (error) {
        values.delete(key);
        throw error;
      }
    },
  };
}
