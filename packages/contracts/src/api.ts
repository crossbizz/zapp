import { z } from 'zod';

/**
 * The one error body every zapp HTTP surface returns, on every non-2xx status.
 * Generated SDKs and the desktop client parse this and nothing else, so a service
 * that invents its own error shape is a breaking change, not a local decision.
 *
 * Strict at both levels: this envelope is the boundary an internal detail would have
 * to cross to reach a tenant, so an unexpected key (a stack, a SQL fragment, a
 * provider payload) fails the parse instead of riding along.
 */
export const ApiErrorSchema = z
  .object({
    error: z
      .object({
        /** Machine code the client branches on: `project_not_found`, `budget_exceeded`, … */
        code: z.string(),
        /** Human, tenant-safe: no secrets, no internals, no provider error text. */
        message: z.string(),
        /** Trace identifier for this request — a plain string, stamped at the edge, not a TypeID. */
        requestId: z.string(),
        /** Structured, tenant-safe context a client can render: which field, which limit. */
        details: z.record(z.unknown()).optional(),
      })
      .strict(),
  })
  .strict();

export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * A page of `item`. Keyset pagination everywhere: `nextCursor` is an opaque cursor
 * the client hands back untouched, and it is explicitly `null` on the last page —
 * never absent, so "the field is missing" can never be misread as "no more results".
 */
export const PageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

/** The parsed page of an item schema, e.g. `Page<typeof ProjectSummarySchema>`. */
export type Page<ItemSchema extends z.ZodTypeAny> = z.infer<
  ReturnType<typeof PageSchema<ItemSchema>>
>;

/**
 * Header carrying the client's idempotency key on every mutating route, which PRD
 * §36.1 requires to be idempotent or key-protected. Lowercase because HTTP/2 field
 * names are, and because clients and servers compare this string literally.
 */
export const IdempotencyHeader = 'idempotency-key' as const;
