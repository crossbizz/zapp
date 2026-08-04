/**
 * Test data for zapp/no-dyad-pro-imports.
 *
 * Lives under `__fixtures__` for one reason: it is the only place in the repo that is
 * *supposed* to contain banned specifiers, and `__fixtures__` is the single exclusion
 * the `license-boundary` CI job carries. Keeping these strings out of the test file
 * itself keeps that exclusion one line wide.
 *
 * These are string literals in a data array, not imports, so the ESLint rule under test
 * does not fire on this file either.
 */

/** The single banned specifier inside `banned-import.ts.txt`. */
export const FIXTURE_SPECIFIER = '@dyad-sh/desktop/pro/main/local_agent';

/**
 * A relative specifier that resolves into `src/pro` from `apps/desktop/src/main.ts`
 * and does not from anywhere else. Used to prove the rule resolves against the
 * importing file rather than the cwd.
 */
export const RELATIVE_PRO_IMPORT = 'import x from "./pro/main/foo";';

/** Every syntax that can pull in a module, across the specifier shapes we ban. */
export const banned = [
  ['bare src/pro path', 'import x from "src/pro/main/foo";'],
  ['nested src/pro path', 'import x from "../../desktop/src/pro/main/foo";'],
  ['relative path resolving into src/pro', RELATIVE_PRO_IMPORT],
  ['parent-relative path into src/pro', 'import x from "../src/pro/main/foo";'],
  ['@/ alias into src/pro', 'import x from "@/pro/shared/search_replace_parser";'],
  ['scoped @dyad package subpath', `import x from "${FIXTURE_SPECIFIER}";`],
  ['side-effect import', 'import "src/pro/main/register";'],
  ['dynamic import', 'const p = import("@dyad-sh/desktop/pro/main/foo");'],
  ['require', 'const x = require("./pro/main/baz");'],
  ['require.resolve', 'const x = require.resolve("src/pro/main/foo");'],
  ['re-export', 'export { y } from "@/pro/shared/y";'],
  ['star re-export', 'export * from "src/pro/shared/y";'],
  ['type-only import', 'import type { T } from "src/pro/types";'],
  ['inline import type', 'type T = import("src/pro/types").T;'],
  ['import-equals', 'import pro = require("src/pro/main/foo");'],
  ['directory import', 'import x from "@/pro";'],
];

/**
 * Legitimate neighbours. Every one of these really occurs in the vendored Dyad tree,
 * and every one is a false positive for a naive /pro/ match.
 */
export const allowed = [
  ['a sibling module literally named pro', 'import x from "./main/pro";'],
  ['the zapp-authored stubs', 'import x from "@/zapp/pro_stubs/shared";'],
  ['a relative stub path', 'import x from "../zapp/pro_stubs/main";'],
  ['a package whose name starts with pro', 'import x from "@dyad-sh/desktop/promises";'],
  ['a src/production directory', 'import x from "src/production/config";'],
  ['a pro-prefixed filename', 'import x from "./providers/pro-tier";'],
  ['an import-equals onto a sibling pro module', 'import pro = require("./main/pro");'],
  ['a marketing URL in a string', 'const url = "https://dyad.sh/pro";'],
  ['a call that is not require', 'const x = load("src/pro/main/foo");'],
  ['a non-literal require', 'const x = require(somePath);'],
];
