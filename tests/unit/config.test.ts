import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';

const validEnvironment = {
  NODE_ENV: 'test',
  PORT: '3000',
  DATABASE_URL: 'mysql://user:password@localhost:3306/resolve_organization',
  REDIS_URL: 'redis://localhost:6379',
  SERVICE_NAME: 'organization-service',
};

describe('configuration', () => {
  it('loads valid configuration and applies defaults', () => {
    expect(loadConfig(validEnvironment)).toMatchObject({
      NODE_ENV: 'test',
      PORT: 3000,
      SERVICE_NAME: 'organization-service',
      LOG_LEVEL: 'info',
    });
  });

  it('rejects missing required configuration', () => {
    const { DATABASE_URL: _databaseUrl, ...missingDatabaseUrl } = validEnvironment;

    expect(() => loadConfig(missingDatabaseUrl)).toThrow(/DATABASE_URL is required/);
  });

  it('rejects invalid Redis configuration', () => {
    expect(() => loadConfig({ ...validEnvironment, REDIS_URL: 'not-a-url' })).toThrow(
      /REDIS_URL must be a valid URL/,
    );
  });

  it('uses the canonical Authentication Service issuer by default', () => {
    expect(loadConfig(validEnvironment).JWT_ISSUER).toBe('resolve-authentication-service');
  });

  it('treats an empty JWT_AUDIENCE as unset (copyable .env.example)', () => {
    const config = loadConfig({ ...validEnvironment, JWT_AUDIENCE: '' });
    expect(config.JWT_AUDIENCE).toBeUndefined();
  });

  it('defaults to the HS256 development JWT verification mode', () => {
    expect(loadConfig(validEnvironment).JWT_ALGORITHM).toBe('hs256');
  });

  it('rejects an unsupported JWT_ALGORITHM', () => {
    expect(() => loadConfig({ ...validEnvironment, JWT_ALGORITHM: 'ed25519' })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
