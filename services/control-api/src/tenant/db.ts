import { newId, type SupportLevel } from '@zapp/contracts';
import {
  forOrg,
  projects,
  type Database,
  type Project,
  type ProjectRepository,
  type TenantDb,
} from '@zapp/db';

import { isUniqueViolation } from '../db/errors.js';

/**
 * The only database handle a route handler is ever given.
 *
 * `forOrg` (plan 01 FND-6) already builds the read side: every query it makes
 * carries `organization_id = <the tenant>` in its own WHERE clause, so a caller
 * holding one cannot express a cross-tenant read. What it deliberately does not
 * build is the write side — an insert has to *set* `organization_id` rather than
 * filter by it, and `packages/db` refuses to hide that.
 *
 * This is where it stops being hidden and starts being impossible to get wrong:
 * the writes below take the organization from the handle they were built with,
 * never from their arguments and never from a request body. A handler that
 * wanted to file a row under another tenant has no parameter to do it with.
 *
 * Everything reachable from here is scoped. Nothing else is exported to a
 * route — see `src/plugins/tenant.ts` and `test/route-isolation.test.ts`.
 */

export interface NewProjectInput {
  readonly name: string;
  readonly slug: string;
  readonly description: string | null;
  /** How the project entered zapp: a prompt, a GitHub import, an upload (PRD §10.1–10.2). */
  readonly sourceType: string;
  readonly supportLevel: SupportLevel;
  readonly createdBy: string;
  readonly now: Date;
}

/**
 * The one outcome of a create that is not an error: the slug is unique *per
 * organization* (two tenants may both own `checkout`), so a collision is a
 * normal answer the caller decides what to do about — retry with a suffix when
 * the slug was derived, 409 when the client chose it. Reported rather than
 * thrown, so no route module has to import an error class from the database
 * layer to handle it.
 */
export type CreatedProject = Project | 'slug_taken';

export interface TenantProjectRepository extends ProjectRepository {
  create(input: NewProjectInput): Promise<CreatedProject>;
}

/** `TenantDb` (reads) plus the writes the control plane owns. */
export interface TenantDatabase extends TenantDb {
  readonly projects: TenantProjectRepository;
}

/**
 * Binds a database handle to one organization. The plugin calls this once per
 * request, with an id it has already checked an active membership for.
 */
export type TenantDbFactory = (organizationId: string) => TenantDatabase;

export function createTenantDbFactory(db: Database): TenantDbFactory {
  return (organizationId: string): TenantDatabase => {
    // `forOrg` validates the id rather than trusting it, which is what turns a
    // bad id into a loud failure here instead of a silently empty query later.
    const scoped = forOrg(db, organizationId);

    return {
      ...scoped,
      projects: {
        ...scoped.projects,
        async create(input: NewProjectInput): Promise<CreatedProject> {
          try {
            const [row] = await db
              .insert(projects)
              .values({
                id: newId('proj'),
                // The handle's organization, full stop. There is deliberately no
                // way for a caller to supply this.
                organizationId: scoped.organizationId,
                name: input.name,
                slug: input.slug,
                description: input.description,
                sourceType: input.sourceType,
                supportLevel: input.supportLevel,
                createdBy: input.createdBy,
                createdAt: input.now,
              })
              .returning();
            if (row === undefined) {
              // Unreachable: an insert with RETURNING yields the row it wrote.
              throw new Error('project insert returned no row');
            }
            return row;
          } catch (error) {
            if (isUniqueViolation(error)) {
              return 'slug_taken';
            }
            throw error;
          }
        },
      },
    };
  };
}
