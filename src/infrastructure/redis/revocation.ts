import type Redis from 'ioredis';
import type { TokenRevocationChecker } from '../../security/auth.types.js';

/**
 * Redis-backed token revocation checker (FR-IAM-06, Authentication contract
 * §3/§15). A revoked access token has a marker at:
 *
 *   session:revoked:{tokenId}
 *
 * The Authentication contract and the Authentication schema disagree on the
 * key prefix (`session:revoked:{tokenId}` vs `resolve:auth:session:revoked:
 * {tokenId}`); this service follows the contract (§3 and §15), which is the
 * document every other service's itegration is written against. Note for the
 * Task 0 freeze: the namespace should be reconciled in one place.
 *
 * Fail-closed: any Redis error propagates to the JWT verifier, which rejects
 * the token — a token whose revocation state cannot be verified is never
 * accepted (Authentication schema §12).
 */
export function createRedisRevocationChecker(redis: Pick<Redis, 'get'>): TokenRevocationChecker {
  return {
    async isRevoked(tokenId) {
      const marker = await redis.get(`session:revoked:${tokenId}`);
      return marker !== null;
    },
  };
}
