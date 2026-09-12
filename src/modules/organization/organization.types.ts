export const OrganizationStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const;

export type OrganizationStatus = (typeof OrganizationStatus)[keyof typeof OrganizationStatus];

export interface Organization {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateOrganizationInput {
  name: string;
  slug: string;
}

export interface UpdateOrganizationInput {
  name?: string;
  slug?: string;
}

export interface ListOrganizationsInput {
  page: number;
  size: number;
  name?: string;
  slug?: string;
  status?: OrganizationStatus;
  sort: OrganizationSort;
}

export interface OrganizationSort {
  field: 'name' | 'slug' | 'status' | 'createdAt' | 'updatedAt';
  direction: 'asc' | 'desc';
}

export interface OrganizationListResult {
  items: Organization[];
  total: number;
  page: number;
  size: number;
}
