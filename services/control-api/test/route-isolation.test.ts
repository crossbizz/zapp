import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The convention that makes tenant isolation structural rather than diligent.
 *
 * A handler cannot read another organization's rows if it never holds anything
 * that could: the only database handle a route module ever sees is
 * `request.tenant.db`, which `forOrg` has already bound to one organization.
 * Nothing in `src/routes/` imports the unscoped `Database`, the Drizzle tables,
 * or `forOrg` itself — so "I forgot the `where organization_id =`" is not a
 * mistake a route is able to make.
 *
 * This is a grep, and a grep is exactly the right shape for it: the property is
 * about what a module is *able* to reach, which is decided by its import list
 * and nothing else. A route that needs something new goes through the tenant
 * handle (`src/tenant/db.ts`) or a port, and this test is what says so at review
 * time instead of six months later.
 */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * Every directory whose modules answer a request.
 *
 * `src/routes` is the obvious one. `src/events` (the SSE endpoint, CP-14) and
 * `src/internal` (service-to-service auth, CP-8) are named by plan 02's own file
 * layout and are handlers by any other name — they were outside this check
 * purely because they do not exist yet, which is the worst possible reason
 * (plan 02 CP-4 review). Listed now, so the first module that lands in either is
 * held to the rule from its first commit. A directory that does not exist yet
 * contributes nothing and fails nothing.
 */
const HANDLER_DIRECTORIES = ['routes', 'events', 'internal'] as const;

/** What a route module may not import, and why it may not. */
const FORBIDDEN: { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: /from\s+'@zapp\/db/,
    why: 'the unscoped database handle and the raw tables — use request.tenant.db',
  },
  {
    pattern: /from\s+'drizzle-orm/,
    why: 'query building belongs behind the tenant handle, not in a handler',
  },
  {
    pattern: /from\s+'[^']*\/tenant\/db\.js'/,
    why: 'the tenant handle is constructed by the plugin and arrives on the request',
  },
  {
    pattern: /\bforOrg\b/,
    why: 'scoping is the tenant plugin’s job; a route that scopes can also forget to',
  },
];

/**
 * Recursive, because `readdirSync` is not: a nested `src/routes/admin/users.ts`
 * used to be invisible to this check, and a convention that stops applying one
 * directory down is not a convention.
 */
function typescriptFilesIn(directory: string): string[] {
  if (!existsSync(directory)) {
    return [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return typescriptFilesIn(path);
    }
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

/** Paths relative to `src/`, so a failure names the module the way an import does. */
function handlerModules(): string[] {
  return HANDLER_DIRECTORIES.flatMap((directory) => typescriptFilesIn(join(SRC, directory)))
    .map((path) => relative(SRC, path))
    .sort();
}

describe('request handlers', () => {
  it('has modules to check', () => {
    // A guard against the test passing because the directory moved: an empty
    // sweep would satisfy every assertion below.
    expect(handlerModules().length).toBeGreaterThan(0);
  });

  it.each(handlerModules())('%s reaches no database handle but the tenant one', (name) => {
    const source = readFileSync(join(SRC, name), 'utf8');
    // Comments are where this convention is explained, so they are stripped
    // before the check — otherwise documenting the rule would break it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const { pattern, why } of FORBIDDEN) {
      expect(pattern.test(code), `${name} must not reach ${why}`).toBe(false);
    }
  });
});
