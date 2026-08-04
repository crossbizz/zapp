import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import rule from '../src/no-dyad-pro-imports.mjs';
// The banned specifiers live in __fixtures__ so this file stays clean for the
// license-boundary CI grep. See the header of specifiers.mjs.
import {
  allowed,
  banned,
  FIXTURE_SPECIFIER,
  RELATIVE_PRO_IMPORT,
} from './__fixtures__/specifiers.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__');

// A fixed virtual cwd keeps flat-config `files` matching independent of where the
// suite is invoked from; none of these paths has to exist on disk.
const CWD = '/repo';
const linter = new Linter({ cwd: CWD });

// A path inside the vendored Dyad tree. Relative specifiers resolve against it, which
// is the whole point: `./pro/main/x` from here IS `src/pro`, `./main/pro` is not.
const FILENAME = `${CWD}/apps/desktop/src/main.ts`;

const config = [
  {
    files: ['**/*.ts'],
    plugins: { zapp: { rules: { 'no-dyad-pro-imports': rule } } },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
    },
    rules: { 'zapp/no-dyad-pro-imports': 'error' },
  },
];

function lint(code, filename = FILENAME) {
  const messages = linter.verify(code, config, filename);
  // A parse error would otherwise masquerade as "no rule violations".
  const fatal = messages.filter((m) => m.fatal);
  if (fatal.length > 0) throw new Error(`fixture failed to parse: ${fatal[0].message}`);
  return messages;
}

describe('zapp/no-dyad-pro-imports', () => {
  it('reports exactly one error for the banned-import fixture', () => {
    const code = readFileSync(path.join(fixtures, 'banned-import.ts.txt'), 'utf8');
    const messages = lint(code);

    expect(messages).toHaveLength(1);
    expect(messages[0].ruleId).toBe('zapp/no-dyad-pro-imports');
    expect(messages[0].messageId).toBe('dyadProImport');
    expect(messages[0].message).toContain(FIXTURE_SPECIFIER);
    // Points at the specifier, not the whole statement.
    expect(messages[0].line).toBe(10);
  });

  it('reports nothing for the clean-import fixture', () => {
    const code = readFileSync(path.join(fixtures, 'clean-import.ts.txt'), 'utf8');
    expect(lint(code)).toEqual([]);
  });

  it.each(banned)('flags %s', (_label, code) => {
    const messages = lint(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].messageId).toBe('dyadProImport');
  });

  it.each(allowed)('allows %s', (_label, code) => {
    expect(lint(code)).toEqual([]);
  });

  it('resolves relative specifiers against the importing file, not the cwd', () => {
    // The same specifier is banned from inside src/ and fine from outside it.
    expect(lint(RELATIVE_PRO_IMPORT, `${CWD}/apps/desktop/src/main.ts`)).toHaveLength(1);
    expect(lint(RELATIVE_PRO_IMPORT, `${CWD}/apps/desktop/e2e/main.ts`)).toEqual([]);
  });
});
