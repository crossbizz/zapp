import { describe, expect, it } from 'vitest';
import {
  AppPathSchema,
  CommitShaSchema,
  EnvironmentIdSchema,
  HttpsUrlSchema,
} from '../src/primitives.js';

// These leaf schemas are shared by several modules, so they are pinned here rather
// than only through whichever consumer happened to exercise them first.

describe('CommitShaSchema', () => {
  const commitSha = '9f2c1b4ad3e5f6071829a0b1c2d3e4f5061728a9';

  it('rejects a commit reference that is not a resolved sha', () => {
    expect(CommitShaSchema.parse(commitSha)).toBe(commitSha);
    expect(CommitShaSchema.safeParse('main').success).toBe(false);
    expect(CommitShaSchema.safeParse(commitSha.toUpperCase()).success).toBe(false);
    expect(CommitShaSchema.safeParse(commitSha.slice(0, 7)).success).toBe(false);
  });
});

describe('EnvironmentIdSchema', () => {
  it('rejects an empty environment id', () => {
    expect(EnvironmentIdSchema.parse('env-production')).toBe('env-production');
    expect(EnvironmentIdSchema.safeParse('').success).toBe(false);
  });
});

describe('HttpsUrlSchema', () => {
  it('accepts https and rejects anything else', () => {
    const url = 'https://preview.modal.example/ws/sb-01H9';
    expect(HttpsUrlSchema.parse(url)).toBe(url);
    expect(HttpsUrlSchema.safeParse('http://preview.modal.example').success).toBe(false);
    expect(HttpsUrlSchema.safeParse('preview.modal.example').success).toBe(false);
  });
});

describe('AppPathSchema', () => {
  it('accepts a rooted path and rejects one that leaves this origin', () => {
    expect(AppPathSchema.parse('/healthz')).toBe('/healthz');
    expect(AppPathSchema.safeParse('health').success).toBe(false);
    // `//evil.example.com/` is a URL to another origin, not a path on this app.
    expect(AppPathSchema.safeParse('//evil.example.com/').success).toBe(false);
  });
});
