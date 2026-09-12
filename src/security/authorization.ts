import type { AuthorizationService } from './auth.types.js';

export function createConfiguredAuthorizationService(userIds: string[]): AuthorizationService {
  const administrators = new Set(userIds);
  return {
    async isSystemAdministrator(userId) {
      return administrators.has(userId);
    },
  };
}
