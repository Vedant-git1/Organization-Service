import 'dotenv/config';
import { z } from 'zod';

/**
 * An optional environment value where an empty string means "not set".
 * Compose and `.env` files routinely forward an unpopulated override as `''`;
 * treating that as absent keeps configuration validation meaningful.
 */
function optionalValue<T extends z.ZodTypeAny>(schema: T) {
  return z
    .string()
    .optional()
    .transform((value) => (value === undefined || value.trim() === '' ? undefined : value))
    .pipe(schema.optional());
}

const environmentSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string({ required_error: 'DATABASE_URL is required' })
    .min(1, 'DATABASE_URL is required'),
  REDIS_URL: z.string().url('REDIS_URL must be a valid URL'),
  SERVICE_NAME: z.string().min(1).default('organization-service'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // JWT verification (access tokens issued by the Authentication Service).
  // Canonical production mechanism: RS256 signed tokens verified against the
  // Authentication Service JWKS (`/.well-known/jwks.json`), selected by `kid`.
  // HS256 with a shared secret remains the explicit local development fallback.
  JWT_ALGORITHM: z.enum(['hs256', 'rs256']).default('hs256'),
  JWT_SECRET: z.string().min(32).optional(),
  JWT_ISSUER: z.string().min(1).default('resolve-authentication-service'),
  // Empty values are treated as unset so `.env.example`/Compose can forward an
  // unpopulated override without failing configuration validation.
  JWT_JWKS_URL: optionalValue(z.string().url('JWT_JWKS_URL must be a valid URL')),
  JWT_AUDIENCE: optionalValue(z.string().min(1)),
  // Internal (service-to-service) authentication.
  // Canonical: mTLS client cert or a signed service-to-service JWT carrying a
  // `service` claim. `service-jwt` is the canonical mechanism; `hmac` is the
  // local development fallback and is refused when NODE_ENV=production.
  INTERNAL_AUTH_MODE: z.enum(['hmac', 'service-jwt']).default('hmac'),
  INTERNAL_AUTH_SECRET: z.string().min(32).optional(),
  INTERNAL_JWT_ISSUER: z.string().min(1).default('resolve-authentication-service'),
  INTERNAL_JWT_JWKS_URL: optionalValue(z.string().url('INTERNAL_JWT_JWKS_URL must be a valid URL')),
  INTERNAL_ALLOWED_SERVICES: z
    .string()
    .default('authentication-service,user-service')
    .transform((value) =>
      value
        .split(',')
        .map((service) => service.trim())
        .filter(Boolean),
    ),
  // Local authorization fallback until the canonical RBAC Service contract is
  // integrated (see docs/adr). Production deployments must resolve System
  // Administrator membership through the canonical RBAC boundary.
  SYSTEM_ADMIN_USER_IDS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((userId) => userId.trim())
        .filter(Boolean),
    ),
});

export type AppConfig = z.infer<typeof environmentSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = environmentSchema.safeParse(env);

  if (!result.success) {
    throw new Error(`Invalid environment configuration: ${result.error.message}`);
  }

  return result.data;
}
