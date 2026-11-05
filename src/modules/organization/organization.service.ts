import { AppError } from '../../shared/errors.js';
import type { AuthContext, AuthorizationService } from '../../security/auth.types.js';
import type { OrganizationRepository } from './organization.repository.js';
import type {
  CreateOrganizationInput,
  ListOrganizationsInput,
  Organization,
  OrganizationListResult,
  OrganizationStatus,
  UpdateOrganizationInput,
} from './organization.types.js';

/**
 * MySQL enforces slug uniqueness; Prisma surfaces the violation as a
 * `PrismaClientKnownRequestError` with code `P2002`. Matching is duck-typed on
 * the code so repository test doubles can exercise the same path deterministically
 * and app-level handling never depends on Prisma's class hierarchy.
 */
function isUniqueConstraintError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code: unknown }).code
      : undefined;
  return code === 'P2002';
}

const forbiddenAdminError = (message: string) => new AppError(403, 'ORG_FORBIDDEN', message);

/**
 * Tenant-scoped public organization service.
 *
 * The authorization boundary is a constructor dependency, not a controller
 * concern: every public operation requires the authenticated actor, and the
 * service refuses to run without an explicit authorization decision. A future
 * public endpoint therefore cannot reach organization data without going
 * through `requireSystemAdministrator` / `requireOwnTenant` below — the tenant
 * isolation rule (`JWT tenantId === organizations.id`, FR-TEN-04) is enforced
 * by construction rather than by remembering to call a guard.
 *
 * Internal service-to-service lookups deliberately live in
 * `InternalOrganizationService`, which has no access to an actor and is only
 * wired into the `/internal/v1` router behind internal authentication.
 */
export class OrganizationService {
  constructor(
    private readonly repository: OrganizationRepository,
    private readonly authorization: AuthorizationService,
  ) {}

  private async requireSystemAdministrator(actor: AuthContext, action: string): Promise<void> {
    if (!(await this.authorization.isSystemAdministrator(actor.userId))) {
      throw forbiddenAdminError(`Only System Administrators may ${action}`);
    }
  }

  private requireOwnTenant(actor: AuthContext, organizationId: string): void {
    if (actor.tenantId !== organizationId) {
      throw forbiddenAdminError('Not a member of this organization');
    }
  }

  async createOrganization(
    input: CreateOrganizationInput,
    actor: AuthContext,
  ): Promise<Organization> {
    await this.requireSystemAdministrator(actor, 'provision organizations');

    if (await this.repository.existsBySlug(input.slug)) {
      throw new AppError(409, 'ORG_SLUG_TAKEN', 'Organization slug is already in use');
    }

    try {
      return await this.repository.create(input);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError(409, 'ORG_SLUG_TAKEN', 'Organization slug is already in use');
      }
      throw error;
    }
  }

  /**
   * Organization contract §2.2: readable by a System Administrator, or by an
   * authenticated user whose JWT `tenantId` claim equals the requested id.
   */
  async getOrganization(id: string, actor: AuthContext): Promise<Organization> {
    if (!(await this.authorization.isSystemAdministrator(actor.userId))) {
      this.requireOwnTenant(actor, id);
    }
    return this.findByIdOrThrow(id);
  }

  async listOrganizations(
    input: ListOrganizationsInput,
    actor: AuthContext,
  ): Promise<OrganizationListResult> {
    await this.requireSystemAdministrator(actor, 'list organizations');
    return this.repository.list(input);
  }

  async updateOrganization(
    id: string,
    input: UpdateOrganizationInput,
    actor: AuthContext,
  ): Promise<Organization> {
    await this.requireSystemAdministrator(actor, 'update organization details');
    await this.findByIdOrThrow(id);

    if (input.slug && (await this.repository.existsBySlug(input.slug, id))) {
      throw new AppError(409, 'ORG_SLUG_TAKEN', 'Organization slug is already in use');
    }

    try {
      return await this.repository.update(id, input);
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError(409, 'ORG_SLUG_TAKEN', 'Organization slug is already in use');
      }
      throw error;
    }
  }

  async updateOrganizationStatus(
    id: string,
    status: OrganizationStatus,
    actor: AuthContext,
  ): Promise<Organization> {
    await this.requireSystemAdministrator(actor, 'change organization status');
    await this.findByIdOrThrow(id);
    return this.repository.updateStatus(id, status);
  }

  private async findByIdOrThrow(id: string): Promise<Organization> {
    const organization = await this.repository.findById(id);
    if (!organization) {
      throw new AppError(404, 'ORG_NOT_FOUND', 'Organization not found');
    }
    return organization;
  }
}

/**
 * Service-to-service lookups (Organization contract §3.3/§3.4). These have no
 * caller tenant context by design: the caller is another Resolve service
 * resolving a tenant id/slug, and access is gated by internal service
 * authentication at the transport boundary instead of by a tenant actor.
 */
export class InternalOrganizationService {
  constructor(private readonly repository: OrganizationRepository) {}

  async getById(id: string): Promise<Organization> {
    const organization = await this.repository.findById(id);
    if (!organization) {
      throw new AppError(404, 'ORG_NOT_FOUND', 'Organization not found');
    }
    return organization;
  }

  /**
   * Returns the organization regardless of status: the Authentication Service
   * must receive a `SUSPENDED` tenant so it can reject the login with a generic
   * anti-enumeration error (Authentication contract §14.0).
   */
  async getBySlug(slug: string): Promise<Organization> {
    const organization = await this.repository.findBySlug(slug);
    if (!organization) {
      throw new AppError(404, 'ORG_NOT_FOUND', 'Organization not found');
    }
    return organization;
  }
}
