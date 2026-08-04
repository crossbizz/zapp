import { newId } from '@zapp/contracts';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';

import { ApiError } from '../src/errors.js';
import { ORGANIZATION_HEADER, selectOrganizationId } from '../src/plugins/tenant.js';

/**
 * Which organization a request names, before anything is asked of the database.
 *
 * This is the first half of tenant resolution and the half with no I/O in it, so
 * it is pinned here rather than only through the full stack: every answer it can
 * give is a security answer, and `test/integration/tenant-isolation.test.ts`
 * exercises the same function through real routes against real rows.
 */

const ORG_A = newId('org');
const ORG_B = newId('org');

/** Only the headers matter to the function under test. */
function request(headers: Record<string, string | string[]> = {}): FastifyRequest {
  return { headers } as unknown as FastifyRequest;
}

/** The `ApiError` a call threw, so a test can assert code and status together. */
function thrownBy(call: () => unknown): ApiError {
  try {
    call();
  } catch (error) {
    if (error instanceof ApiError) {
      return error;
    }
    throw error;
  }
  throw new Error('expected the call to throw');
}

describe('selectOrganizationId', () => {
  it('takes the organization from the header when there is no route param', () => {
    expect(selectOrganizationId(request({ [ORGANIZATION_HEADER]: ORG_A }))).toBe(ORG_A);
  });

  it('takes it from the route param when there is no header', () => {
    expect(selectOrganizationId(request(), ORG_A)).toBe(ORG_A);
  });

  it('accepts a header that agrees with the route param', () => {
    expect(selectOrganizationId(request({ [ORGANIZATION_HEADER]: ORG_A }), ORG_A)).toBe(ORG_A);
  });

  it('refuses a header that names a different organization than the path', () => {
    // The whole point: a request whose two halves disagree must never be
    // resolved in favour of either one. 404 rather than 400, so the answer does
    // not report which of the two organizations exists.
    const error = thrownBy(() =>
      selectOrganizationId(request({ [ORGANIZATION_HEADER]: ORG_B }), ORG_A),
    );
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('organization_not_found');
  });

  it('asks for an organization when neither the header nor the path names one', () => {
    const error = thrownBy(() => selectOrganizationId(request()));
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('organization_required');
  });

  it('treats a blank header as no header at all', () => {
    const error = thrownBy(() => selectOrganizationId(request({ [ORGANIZATION_HEADER]: '   ' })));
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('organization_required');
  });

  it('reads a malformed organization id as one that does not exist', () => {
    // Not a validation error: a 400 here would tell a caller that the *shape* of
    // an id is all that stands between them and an organization, and the
    // answer for "no organization of yours" is one answer.
    const malformed = [
      'org_',
      'not-an-id',
      // The right shape, the wrong entity: a project id must not scope a tenant.
      'proj_01J8ME7YQZJ2V9Q0X3T5B6K7N9',
      // A ULID with a character Crockford base32 excludes.
      'org_01J8ME7YQZJ2V9Q0X3T5B6K7NI',
      `${ORG_A} or 1=1`,
    ];
    for (const value of malformed) {
      const error = thrownBy(() => selectOrganizationId(request({ [ORGANIZATION_HEADER]: value })));
      expect(error.statusCode, value).toBe(404);
      expect(error.code, value).toBe('organization_not_found');
    }
  });

  it('refuses a header sent twice', () => {
    // Node joins repeated headers into one comma-separated value, so a client
    // that sends two organizations gets neither.
    const error = thrownBy(() =>
      selectOrganizationId(request({ [ORGANIZATION_HEADER]: `${ORG_A}, ${ORG_B}` })),
    );
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('organization_not_found');
  });

  it('refuses an array-valued header rather than picking one of them', () => {
    const error = thrownBy(() =>
      selectOrganizationId(request({ [ORGANIZATION_HEADER]: [ORG_A, ORG_B] })),
    );
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('organization_not_found');
  });
});
