import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

const ROUTES_DIR = fileURLToPath(new URL('../src/routes', import.meta.url));

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

function routeModules(): string[] {
  return readdirSync(ROUTES_DIR)
    .filter((name) => name.endsWith('.ts'))
    .sort();
}

describe('src/routes', () => {
  it('has route modules to check', () => {
    // A guard against the test passing because the directory moved: an empty
    // sweep would satisfy every assertion below.
    expect(routeModules().length).toBeGreaterThan(0);
  });

  it.each(routeModules())('%s reaches no database handle but the tenant one', (name) => {
    const source = readFileSync(join(ROUTES_DIR, name), 'utf8');
    // Comments are where this convention is explained, so they are stripped
    // before the check — otherwise documenting the rule would break it.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const { pattern, why } of FORBIDDEN) {
      expect(pattern.test(code), `${name} must not reach ${why}`).toBe(false);
    }
  });
});
