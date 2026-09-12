/**
 * Authenticated caller context derived from a verified Resolve access JWT.
 *
 * Contractually (Authentication Service contract §3, FR-TEN-04, Organization
 * Service contract §2.2): `tenantId` IS the Organization Service's
 * `organizations.id`. Every tenant-scoped check in this service compares the
 * requested organization id against this claim. `sub` is the user id
 * (`users.id`), `tokenId` is the revocation key (`session:revoked:{tokenId}`).
 * Roles/permissions are deliberately absent from the JWT and must never be
 * treated as authoritative authorization data.
 */
export interface AuthContext {
  userId: string;
  /** The caller's tenant id — equals `organizations.id` (FR-TEN-04). */
  tenantId: string;
  tokenId: string;
}

/**
 * Centralized authorization boundary (FR-AUZ-02). The Organization Service does
 * not own RBAC data. The canonical System Administrator resolution lives in the
 * RBAC Service (Task 5); no RBAC contract document is present in this workspace,
 * so this adapter currently resolves System Administrator membership from a
 * static configuration list (`SYSTEM_ADMIN_USER_IDS`) as a documented local
 * fallback. Production integration MUST replace this adapter with the canonical
 * RBAC contract before it can be considered production-ready authorization.
 */
export interface AuthorizationService {
  isSystemAdministrator(userId: string): Promise<boolean>;
}

export interface InternalAuthContext {
  serviceName: string;
}

/**
 * Internal (service-to-service) authentication boundary.
 *
 * Canonical contract: mTLS client cert OR a signed service-to-service JWT
 * carrying a `service` claim. The caller's forwarded end-user token must never
 * be used for internal calls. Implementations:
 * - `service-jwt` — canonical signed service JWT verification.
 * - `hmac` — local development fallback only; refused in production.
 */
export interface InternalAuthService {
  authenticate(headers: {
    serviceName?: string;
    signature?: string;
    timestamp?: string;
    /** Raw (lower-cased by Express) value of the Authorization header. */
    authorization?: string;
    method: string;
    path: string;
  }): Promise<InternalAuthContext>;
}

/**
 * Token revocation check (FR-IAM-06, Authentication contract §3).
 * Every verifying service must reject a token whose `tokenId` appears in
 * `session:revoked:{tokenId}`. Unavailability MUST fail closed — a token whose
 * revocation state cannot be verified must not be accepted.
 */
export interface TokenRevocationChecker {
  isRevoked(tokenId: string): Promise<boolean>;
}
