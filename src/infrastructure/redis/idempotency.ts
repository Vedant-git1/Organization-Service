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

/** Reservation lifetime: bounds how long an abandoned in-flight key blocks retries. */
const reservationTtlSeconds = 120;
/** Completed-result lifetime: a retry inside this window replays the original response. */
const resultTtlSeconds = 86400;
/** How long a duplicate in-flight request waits for the original to finish. */
const pendingWaitTimeoutMs = 5000;
const pendingPollIntervalMs = 25;

/**
 * Canonical Redis namespace for organization-create idempotency
 * (`idempotency:{key}`). Do not rename.
 */
const idempotencyKeyPrefix = 'idempotency:';

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Key-order independent request fingerprint. Two requests carrying the same
 * body in a different property order must be treated as the same request.
 */
export function requestHash(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

function parseStored(value: string | null): StoredIdempotencyResult | undefined {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as StoredIdempotencyResult;
  } catch {
    return undefined;
  }
}

function keyReusedError(): AppError {
  return new AppError(
    409,
    'IDEMPOTENCY_KEY_REUSED',
    'Idempotency-Key was already used with a different request body',
  );
}

function requestInProgressError(): AppError {
  return new AppError(
    409,
    'IDEMPOTENCY_REQUEST_IN_PROGRESS',
    'A request with this idempotency key is still in progress',
  );
}

function storageUnavailableError(): AppError {
  return new AppError(503, 'ORG_DEPENDENCY_UNAVAILABLE', 'Idempotency storage is unavailable');
}

/**
 * Resolves a duplicate request against an existing reservation.
 *
 * The same key with a different body is always a conflict. The same key with
 * the same body either replays the completed result, or — while the original
 * request is still running — waits for it to complete so both callers observe
 * the same response ("same idempotency key + same request → same result";
 * "repeated request must not create duplicate organizations"). If the original
 * does not complete inside the bounded wait, the caller receives a defined
 * conflict instead of a duplicate side effect.
 */
async function awaitExistingResult<T>(
  hash: string,
  storageKey: string,
  read: (key: string) => Promise<StoredIdempotencyResult | undefined>,
  waitTimeoutMs: number,
): Promise<{ statusCode: number; body: T }> {
  const deadline = Date.now() + waitTimeoutMs;
  for (;;) {
    const existing = await read(storageKey);
    if (!existing || existing.hash !== hash) {
      throw keyReusedError();
    }
    if (existing.state === 'complete') {
      return { statusCode: existing.statusCode ?? 200, body: existing.body as T };
    }
    if (Date.now() >= deadline) {
      throw requestInProgressError();
    }
    await delay(pendingPollIntervalMs);
  }
}

export function createRedisIdempotencyStore(
  redis: Pick<Redis, 'set' | 'get' | 'del'>,
  options: { pendingWaitTimeoutMs?: number } = {},
): IdempotencyStore {
  const waitTimeoutMs = options.pendingWaitTimeoutMs ?? pendingWaitTimeoutMs;
  const read = async (storageKey: string): Promise<StoredIdempotencyResult | undefined> => {
    try {
      return parseStored(await redis.get(storageKey));
    } catch {
      // A reservation whose state cannot be read must never be treated as "no
      // reservation" — that would allow a duplicate side effect.
      throw storageUnavailableError();
    }
  };

  return {
    async execute<T>(key: string, input: unknown, operation: IdempotencyOperation<T>) {
      const hash = requestHash(input);
      const storageKey = `${idempotencyKeyPrefix}${key}`;
      const pending: StoredIdempotencyResult = { hash, state: 'pending' };

      let acquired: string | null;
      try {
        acquired = await redis.set(
          storageKey,
          JSON.stringify(pending),
          'EX',
          reservationTtlSeconds,
          'NX',
        );
      } catch {
        // Fail closed: without a reservation the service cannot guarantee
        // at-most-once creation, so it refuses to create anything.
        throw storageUnavailableError();
      }

      if (acquired !== 'OK') {
        return awaitExistingResult<T>(hash, storageKey, read, waitTimeoutMs);
      }

      try {
        const response = await operation();
        const complete: StoredIdempotencyResult = {
          hash,
          state: 'complete',
          statusCode: response.statusCode,
          body: response.body,
        };
        try {
          await redis.set(storageKey, JSON.stringify(complete), 'EX', resultTtlSeconds);
        } catch {
          // The organization was created; only the replay record failed to
          // persist. The reservation expires by TTL, so the successful
          // response is still returned rather than reporting a false failure.
        }
        return response;
      } catch (error) {
        try {
          await redis.del(storageKey);
        } catch {
          // Releasing the reservation is best effort; the TTL expires it. The
          // original failure is what the caller must observe.
        }
        throw error;
      }
    },
  };
}

export function createMemoryIdempotencyStore(
  options: { pendingWaitTimeoutMs?: number } = {},
): IdempotencyStore {
  const waitTimeoutMs = options.pendingWaitTimeoutMs ?? pendingWaitTimeoutMs;
  const values = new Map<string, StoredIdempotencyResult>();
  const read = async (storageKey: string): Promise<StoredIdempotencyResult | undefined> =>
    values.get(storageKey);

  return {
    async execute<T>(key: string, input: unknown, operation: IdempotencyOperation<T>) {
      const hash = requestHash(input);
      if (values.has(key)) {
        return awaitExistingResult<T>(hash, key, read, waitTimeoutMs);
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
