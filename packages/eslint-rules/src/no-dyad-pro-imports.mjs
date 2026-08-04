import path from 'node:path';

/**
 * Upstream Dyad is dual-licensed: everything outside `src/pro/` is Apache-2.0, while
 * `src/pro/` is proprietary (Functional Source License 1.1). Only the Apache-2.0
 * portion is vendored here (see `NOTICE` and `docs/adr/0002-dyad-fork.md`), so master
 * plan global constraint 17 bans importing `src/pro` from anywhere in this repo.
 *
 * This is the ESLint half of that ban. The CI half is the `license-boundary` job in
 * `.github/workflows/security.yml`, which greps `apps/desktop` too -- the vendored tree
 * is not linted by the root ESLint config, so the grep is what actually guards it.
 */

/**
 * Matches a specifier that points into Dyad's Pro tree:
 *   - a `src/pro` path segment, e.g. `src/pro/main/x` (also the resolved form of any
 *     relative or `@/`-aliased specifier -- see {@link resolveSpecifier});
 *   - a `pro` subpath of a `@dyad*` package, e.g. `@dyad-sh/desktop/pro/main/x`.
 *
 * Deliberately segment-anchored: `src/production/x`, `./main/pro`, `pro_stubs/` and
 * `@dyad-sh/desktop/promises` are all legitimate and must not match.
 */
const PRO_SPECIFIER = /(^|\/)src\/pro(\/|$)|@dyad[^'"]*\/pro(\/|$)/;

/**
 * Reduces a specifier to a comparable path so the segment match above can be applied.
 *
 * Relative specifiers are resolved against the importing file, which is the only way to
 * tell `./pro/main/x` (which IS `src/pro` when imported from `src/main.ts`) apart from
 * `./main/pro` (which is `src/main/pro.ts`, Apache-2.0). Bare specifiers are returned
 * unchanged so the `@dyad*` half of the pattern still sees them.
 *
 * @param {string} specifier import specifier as written
 * @param {string} filename absolute path of the file containing the import
 * @returns {string} a POSIX-separated path or the original bare specifier
 */
function resolveSpecifier(specifier, filename) {
  // Dyad's tsconfig maps `@/*` onto `src/*`, so `@/pro/x` is `src/pro/x`.
  if (specifier.startsWith('@/')) return `src/${specifier.slice(2)}`;
  if (specifier.startsWith('.')) {
    return path.resolve(path.dirname(filename), specifier).split(path.sep).join('/');
  }
  return specifier;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        "Ban imports of Dyad's proprietary `src/pro` code, which is not Apache-2.0 and is not vendored.",
    },
    schema: [],
    messages: {
      dyadProImport:
        'License boundary: "{{specifier}}" imports Dyad Pro code. Dyad `src/pro` is ' +
        'Functional Source License 1.1, not Apache-2.0, and is not vendored in this ' +
        'repository (see NOTICE and docs/adr/0002-dyad-fork.md). Use the zapp-authored ' +
        'stubs in apps/desktop/src/zapp/pro_stubs/ or write a replacement from scratch.',
    },
  },

  create(context) {
    const filename = context.filename;

    /**
     * @param {import('estree').Node} node node to attribute the report to
     * @param {unknown} specifier the specifier's literal value
     */
    function check(node, specifier) {
      if (typeof specifier !== 'string') return;
      if (!PRO_SPECIFIER.test(resolveSpecifier(specifier, filename))) return;
      context.report({ node, messageId: 'dyadProImport', data: { specifier } });
    }

    /** @param {{ source?: { value?: unknown } | null }} node */
    function checkSource(node) {
      if (node.source) check(node.source, node.source.value);
    }

    return {
      // `import x from '...'`, `import '...'`, `export { x } from '...'`, `export * from '...'`.
      // A re-export pulls the module in exactly like an import does.
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,

      // `import('...')`
      ImportExpression(node) {
        if (node.source.type === 'Literal') check(node.source, node.source.value);
      },

      // `require('...')` and `require.resolve('...')`
      CallExpression(node) {
        const callee = node.callee;
        const isRequire =
          (callee.type === 'Identifier' && callee.name === 'require') ||
          (callee.type === 'MemberExpression' &&
            !callee.computed &&
            callee.object.type === 'Identifier' &&
            callee.object.name === 'require' &&
            callee.property.type === 'Identifier' &&
            callee.property.name === 'resolve');
        if (!isRequire) return;

        const [arg] = node.arguments;
        if (arg && arg.type === 'Literal') check(arg, arg.value);
      },

      // `type T = import('...').T` -- a type-only reference is still a reference to the
      // Pro source. typescript-eslint renamed this property `argument` -> `source` and
      // has both wrapped and unwrapped it in a TSLiteralType across major versions, so
      // every shape is accepted rather than pinning the rule to one parser version.
      // `source` is read first: touching the deprecated `argument` emits a warning.
      TSImportType(node) {
        const argument = node.source ?? node.argument;
        const literal = argument.type === 'TSLiteralType' ? argument.literal : argument;
        if (literal.type === 'Literal') check(literal, literal.value);
      },
    };
  },
};

export default rule;
