import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ApiErrorSchema, IdempotencyHeader, PageSchema, type Page } from '../src/api.js';
import { idSchema } from '../src/ids.js';

// The request id is deliberately a plain string, not a TypeID: it is the trace
// identifier the edge already stamps on the request, and it has to survive being
// echoed back verbatim.
const requestId = '0af7651916cd43dd8448eb211c80319c';

describe('ApiErrorSchema', () => {
  const envelope = {
    error: {
      code: 'project_not_found',
      message: 'No project with that id.',
      requestId,
    },
  };

  it('round-trips the envelope every service returns', () => {
    expect(ApiErrorSchema.parse(envelope)).toEqual(envelope);
  });

  it('round-trips machine-readable details of any JSON shape', () => {
    const withDetails = {
      error: {
        code: 'budget_exceeded',
        message: 'This run would exceed the monthly budget.',
        requestId,
        details: { limitCents: 50_000, spentCents: 50_120, retryable: false, gates: ['budget'] },
      },
    };
    expect(ApiErrorSchema.parse(withDetails)).toEqual(withDetails);
  });

  it('leaves absent details absent instead of setting undefined', () => {
    const parsed = ApiErrorSchema.parse(envelope);
    expect('details' in parsed.error).toBe(false);
  });

  it('rejects an unknown key at either level', () => {
    // Strict at the top level: the envelope has one key, so a sibling field is a
    // second, undocumented error shape.
    expect(ApiErrorSchema.safeParse({ ...envelope, status: 404 }).success).toBe(false);
    // Strict inside `error`: this is the one place an internal detail could ride out
    // to a tenant, so anything not in the contract is a parse failure, not a passenger.
    expect(
      ApiErrorSchema.safeParse({ error: { ...envelope.error, stack: 'at db.query (pg.js:1)' } })
        .success,
    ).toBe(false);
  });

  it('rejects a bare error object outside the envelope', () => {
    expect(ApiErrorSchema.safeParse(envelope.error).success).toBe(false);
  });

  it('rejects an error missing its code, message or request id', () => {
    expect(ApiErrorSchema.safeParse({ error: { message: 'x', requestId } }).success).toBe(false);
    expect(
      ApiErrorSchema.safeParse({ error: { code: 'project_not_found', requestId } }).success,
    ).toBe(false);
    // Untraceable errors are the ones support cannot act on, so the id is required.
    expect(
      ApiErrorSchema.safeParse({ error: { code: 'project_not_found', message: 'x' } }).success,
    ).toBe(false);
  });
});

describe('PageSchema', () => {
  const ProjectSummarySchema = z.object({ id: idSchema('proj'), name: z.string().min(1) });
  const projectId = 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB';

  it('pages a composite item schema', () => {
    const ProjectPageSchema = PageSchema(ProjectSummarySchema);
    const page = { items: [{ id: projectId, name: 'storefront' }], nextCursor: null };
    // Typed through the schema, never hand-written: the annotation fails to compile
    // if the inferred page shape drifts.
    const parsed: Page<typeof ProjectSummarySchema> = ProjectPageSchema.parse(page);
    expect(parsed).toEqual(page);
  });

  it('pages a bare id schema', () => {
    const IdPageSchema = PageSchema(idSchema('proj'));
    const page = { items: [projectId], nextCursor: 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NB' };
    expect(IdPageSchema.parse(page)).toEqual(page);
    expect(
      IdPageSchema.safeParse({ items: ['run_01J8ME7YQZJ2V9Q0X3T5B6K7N9'], nextCursor: null })
        .success,
    ).toBe(false);
  });

  it('accepts an empty page', () => {
    expect(PageSchema(ProjectSummarySchema).parse({ items: [], nextCursor: null })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  it('carries the keyset cursor as either a string or an explicit null', () => {
    const IdPageSchema = PageSchema(idSchema('proj'));
    expect(IdPageSchema.parse({ items: [], nextCursor: null }).nextCursor).toBeNull();
    expect(IdPageSchema.parse({ items: [], nextCursor: 'cursor-2' }).nextCursor).toBe('cursor-2');
  });

  it('rejects a page that omits the cursor', () => {
    // Absent must never stand in for null: a client that dropped the field would
    // otherwise be indistinguishable from the last page and stop paging early.
    expect(PageSchema(idSchema('proj')).safeParse({ items: [] }).success).toBe(false);
  });

  it('rejects an item the item schema rejects', () => {
    expect(
      PageSchema(ProjectSummarySchema).safeParse({
        items: [{ id: projectId, name: '' }],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});

describe('IdempotencyHeader', () => {
  it('is the lowercase header name every mutating route reads', () => {
    // Written out rather than derived: clients and SDKs key off this exact string,
    // and HTTP/2 requires lowercase field names.
    expect(IdempotencyHeader).toBe('idempotency-key');
  });
});
