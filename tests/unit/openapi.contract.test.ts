import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * Contract guard for `docs/openapi.yaml` (requirements §17, §24).
 *
 * The OpenAPI document is part of the service contract, so it is verified
 * mechanically rather than by inspection: every `$ref` must resolve, the
 * organization representation must contain exactly the fields this service
 * owns, and the documented status codes must match what the routes produce.
 */
const document = yaml.load(
  readFileSync(path.resolve(process.cwd(), 'docs/openapi.yaml'), 'utf8'),
) as Record<string, unknown>;

function resolvePointer(pointer: string): unknown {
  const segments = pointer.replace(/^#\//, '').split('/');
  return segments.reduce<unknown>((current, segment) => {
    if (current === null || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }, document);
}

function collectReferences(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) collectReferences(item, found);
    return found;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.push(value);
      else collectReferences(value, found);
    }
  }
  return found;
}

const paths = document.paths as Record<string, Record<string, Record<string, unknown>>>;
const components = document.components as Record<string, Record<string, unknown>>;
const schemas = components.schemas;
const responses = components.responses;

function responseCodes(path: string, method: string): string[] {
  const entry = paths[path]?.[method] as { responses?: Record<string, unknown> } | undefined;
  return Object.keys(entry?.responses ?? {});
}

function parameterNames(path: string, method: string): string[] {
  const entry = paths[path]?.[method] as
    { parameters?: Array<{ $ref?: string; name?: string }> } | undefined;
  return (entry?.parameters ?? []).map((parameter) => {
    if (parameter.name) return parameter.name;
    const resolved = resolvePointer(parameter.$ref ?? '') as { name?: string } | undefined;
    return resolved?.name ?? '';
  });
}

describe('OpenAPI contract', () => {
  it('resolves every internal $ref', () => {
    const references = collectReferences(document);
    expect(references.length).toBeGreaterThan(0);

    const unresolved = references.filter((reference) => resolvePointer(reference) === undefined);
    expect(unresolved).toEqual([]);
  });

  it('documents the public organization surface', () => {
    expect(responseCodes('/api/v1/organizations', 'post')).toEqual(
      expect.arrayContaining(['201', '400', '401', '403', '409']),
    );
    expect(responseCodes('/api/v1/organizations', 'get')).toEqual(
      expect.arrayContaining(['200', '400', '401', '403']),
    );
    expect(responseCodes('/api/v1/organizations/{id}', 'get')).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404']),
    );
    expect(responseCodes('/api/v1/organizations/{id}', 'patch')).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404', '409']),
    );
    expect(responseCodes('/api/v1/organizations/{id}/status', 'patch')).toEqual(
      expect.arrayContaining(['200', '400', '401', '403', '404']),
    );
    expect(parameterNames('/api/v1/organizations', 'post')).toContain('Idempotency-Key');
  });

  it('documents zero-based pagination, filtering, and the canonical sort syntax', () => {
    expect(parameterNames('/api/v1/organizations', 'get')).toEqual(
      expect.arrayContaining(['page', 'size', 'name', 'slug', 'status', 'sort']),
    );

    const page = resolvePointer('#/components/parameters/Page') as {
      schema: { minimum: number; default: number };
    };
    const size = resolvePointer('#/components/parameters/Size') as {
      schema: { minimum: number; maximum: number; default: number };
    };
    expect(page.schema).toMatchObject({ minimum: 0, default: 0 });
    expect(size.schema).toMatchObject({ minimum: 1, maximum: 100, default: 20 });

    const sort = (
      paths['/api/v1/organizations']?.get as {
        parameters: Array<{ name: string; schema: { pattern: string } }>;
      }
    ).parameters.find((parameter) => parameter.name === 'sort');
    expect(sort?.schema.pattern).toContain('createdAt');
  });

  it('documents the canonical internal endpoints with the summary representation', () => {
    for (const endpoint of [
      '/internal/v1/organizations/{id}',
      '/internal/v1/organizations/by-slug/{slug}',
    ]) {
      expect(paths[endpoint]).toBeDefined();
      expect(responseCodes(endpoint, 'get')).toEqual(
        expect.arrayContaining(['200', '400', '401', '404']),
      );
      const schema = (
        paths[endpoint]?.get as {
          responses: Record<string, { content: Record<string, { schema: { $ref: string } }> }>;
        }
      ).responses['200'].content['application/json'].schema;
      expect(schema.$ref).toBe('#/components/schemas/OrganizationSummary');
    }
  });

  it('owns exactly the organization fields defined by the contract', () => {
    // Scope guard: id, name, slug, status, created_at, updated_at — nothing else.
    const organization = schemas.Organization as { properties: Record<string, unknown> };
    expect(Object.keys(organization.properties).sort()).toEqual([
      'createdAt',
      'id',
      'name',
      'slug',
      'status',
      'updatedAt',
    ]);

    const summary = schemas.OrganizationSummary as { properties: Record<string, unknown> };
    expect(Object.keys(summary.properties).sort()).toEqual(['id', 'name', 'slug', 'status']);
  });

  it('documents the canonical error shape on every failure response', () => {
    const errorResponse = schemas.ErrorResponse as { required: string[] };
    expect(errorResponse.required.slice().sort()).toEqual([
      'code',
      'message',
      'path',
      'requestId',
      'status',
      'timestamp',
      'traceId',
    ]);

    for (const name of ['Unauthorized', 'Forbidden', 'ValidationError', 'NotFound', 'Conflict']) {
      const response = responses[name] as {
        content: Record<string, { schema: { $ref: string } }>;
      };
      expect(response.content['application/json'].schema.$ref).toBe(
        '#/components/schemas/ErrorResponse',
      );
    }
  });

  it('documents both internal authentication mechanisms and the health endpoints', () => {
    const securitySchemes = components.securitySchemes as Record<
      string,
      { type: string; scheme?: string }
    >;

    expect(securitySchemes.bearerAuth).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(securitySchemes.internalServiceJwt).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(securitySchemes.internalServiceAuth.type).toBe('apiKey');
    expect(Object.keys(paths)).toEqual(expect.arrayContaining(['/health', '/health/ready']));
  });
});
