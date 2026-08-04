/**
 * Keyset pagination, in one place.
 *
 * Master plan §7 requires every list endpoint to be keyset-paginated, and the
 * FND-10 envelope fixes the wire shape: `items` plus a `nextCursor` that is
 * explicitly `null` on the last page. What a *store* returns has to line up with
 * that exactly, so the two sides of every paginated route are described by one
 * pair of types rather than by a copy per module.
 *
 * The cursor is the last id of the page just returned. Ids are monotonic ULIDs,
 * so ordering by id descending is both newest-first and a total order — which is
 * what makes "rows strictly after the cursor" unambiguous, and what stops a row
 * inserted mid-pagination from shifting a page boundary underneath a client.
 */

export interface PageRequest {
  readonly limit: number;
  /** The `nextCursor` of the previous page; rows strictly after it are returned. */
  readonly cursor?: string;
}

/** One keyset page. `nextCursor` is null on the last one — never absent (FND-10). */
export interface StorePage<T> {
  readonly items: T[];
  readonly nextCursor: string | null;
}

/** How many rows a page carries when the client does not say. */
export const DEFAULT_PAGE_SIZE = 50;
