import { describe, expect, it } from 'vitest';
import { idSchema, newId, type IdPrefix } from '../src/ids.js';

// Master plan §Global Constraints owns this list; typing it as IdPrefix[] turns
// a typo or a dropped prefix into a compile error rather than a silent gap.
const ALL_PREFIXES: readonly IdPrefix[] = [
  'org',
  'user',
  'proj',
  'run',
  'task',
  'ws',
  'rel',
  'dep',
  'evt',
  'art',
  'spec',
  'sec',
];

describe('newId', () => {
  it('mints an id its own prefix schema accepts', () => {
    for (const prefix of ALL_PREFIXES) {
      const id = newId(prefix);
      expect(id.startsWith(`${prefix}_`)).toBe(true);
      expect(idSchema(prefix).safeParse(id).success).toBe(true);
    }
  });
  it('stays unique and lexicographically ascending inside a single millisecond', () => {
    const ids = Array.from({ length: 500 }, () => newId('evt'));
    expect(new Set(ids).size).toBe(ids.length);
    // Unique plus already-sorted means strictly ascending.
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('idSchema', () => {
  it('rejects an id minted for a different entity', () => {
    for (const prefix of ALL_PREFIXES) {
      const other: IdPrefix = prefix === 'org' ? 'run' : 'org';
      expect(idSchema(prefix).safeParse(newId(other)).success).toBe(false);
    }
  });
  it('rejects malformed ids', () => {
    const schema = idSchema('run');
    const malformed = [
      '',
      'run',
      'run_',
      '01J8ME7YQZJ2V9Q0X3T5B6K7N8',
      'run_01J8ME7YQZJ2V9Q0X3T5B6K7N', // 25 characters
      'run_01J8ME7YQZJ2V9Q0X3T5B6K7N88', // 27 characters
      'run_01j8me7yqzj2v9q0x3t5b6k7n8', // lowercase
      'run_01J8ME7YQZJ2V9Q0X3T5B6K7NI', // I, L, O and U are not Crockford base32
      'run_01J8ME7YQZJ2V9Q0X3T5B6K7NL',
      'run_01J8ME7YQZJ2V9Q0X3T5B6K7NO',
      'run_01J8ME7YQZJ2V9Q0X3T5B6K7NU',
      'run-01J8ME7YQZJ2V9Q0X3T5B6K7N8', // wrong separator
      'xrun_01J8ME7YQZJ2V9Q0X3T5B6K7N8',
      ' run_01J8ME7YQZJ2V9Q0X3T5B6K7N8',
      'run_01J8ME7YQZJ2V9Q0X3T5B6K7N8 ',
      'run_01J8ME7YQZJ2V9Q0X3T5B6K7N8\n', // `$` must not match before a newline
      'run_01J8ME7YQZJ2V9Q0X3T5B6K7N8;DROP',
    ];
    for (const candidate of malformed) {
      expect(schema.safeParse(candidate).success).toBe(false);
    }
  });
  it('never repeats the rejected value in its error', () => {
    // Ids reach logs and error responses; the value that failed must not ride
    // along, since callers pass user-supplied strings straight in.
    const result = idSchema('org').safeParse('org_leaked-secret-value');
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.message).not.toContain('leaked-secret-value');
  });
});
