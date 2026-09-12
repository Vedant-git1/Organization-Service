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

export class OrganizationService {
  constructor(private readonly repository: OrganizationRepository) {}

  async createOrganization(input: CreateOrganizationInput): Promise<Organization> {
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

  async getOrganization(id: string): Promise<Organization> {
    const organization = await this.repository.findById(id);
    if (!organization) {
      throw new AppError(404, 'ORG_NOT_FOUND', 'Organization not found');
    }
    return organization;
  }

  async getOrganizationForActor(
    id: string,
    auth: AuthContext,
    authorization: AuthorizationService,
  ): Promise<Organization> {
    if (await authorization.isSystemAdministrator(auth.userId)) {
      return this.getOrganization(id);
    }
    // FR-TEN-04 / Organization contract §2.2: the JWT `tenantId` claim IS the
    // organization id. Only members of the requested organization may read it.
    if (auth.tenantId !== id) {
      throw new AppError(403, 'ORG_FORBIDDEN', 'Not a member of this organization');
    }
    return this.getOrganization(id);
  }

  async getOrganizationBySlug(slug: string): Promise<Organization> {
    const organization = await this.repository.findBySlug(slug);
    if (!organization) {
      throw new AppError(404, 'ORG_NOT_FOUND', 'Organization not found');
    }
    return organization;
  }

  async listOrganizations(input: ListOrganizationsInput): Promise<OrganizationListResult> {
    return this.repository.list(input);
  }

  async updateOrganization(id: string, input: UpdateOrganizationInput): Promise<Organization> {
    await this.getOrganization(id);

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

  async updateOrganizationStatus(id: string, status: OrganizationStatus): Promise<Organization> {
    await this.getOrganization(id);
    return this.repository.updateStatus(id, status);
  }
}
