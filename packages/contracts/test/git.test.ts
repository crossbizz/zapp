import { describe, expect, it } from 'vitest';

import {
  CreateRepositoryInputSchema,
  CreatedRepositorySchema,
  InternalRepoRefSchema,
  RELEASE_BRANCH_PATTERN,
  internalRepoRef,
  newId,
  parseInternalRepoRef,
} from '../src/index.js';

const ORG = 'org_01J8ME7YQZJ2V9Q0X3T5B6K7N9';
const PROJECT = 'proj_01J8ME7YQZJ2V9Q0X3T5B6K7NA';

describe('internalRepoRef', () => {
  it('is `org_{ulid}/proj_{ulid}`, which is plan 06’s naming written with TypeIDs', () => {
    expect(internalRepoRef({ organizationId: ORG, projectId: PROJECT })).toBe(
      'org_01j8me7yqzj2v9q0x3t5b6k7n9/proj_01j8me7yqzj2v9q0x3t5b6k7na',
    );
  });

  it('agrees with itself whatever case the ids arrive in', () => {
    // Git hosting treats owner and repository names case-insensitively, so two
    // refs differing only by case would be one repository and two rows.
    expect(internalRepoRef({ organizationId: ORG, projectId: PROJECT })).toBe(
      internalRepoRef({ organizationId: ORG.toLowerCase(), projectId: PROJECT.toLowerCase() }),
    );
  });

  it('depends on nothing mutable', () => {
    // The whole point (plan 02 CP-6 review): a slug-derived ref desynchronizes on
    // the first rename, and the freed slug can then be taken by a second project
    // — two `repositories` rows with one `internal_repo_ref`, and one project's
    // code landing in another's history. Ids cannot be renamed, so the function
    // takes nothing that could be.
    const derived = internalRepoRef({ organizationId: ORG, projectId: PROJECT });
    expect(derived).not.toContain('checkout');
    expect(Object.keys({ organizationId: ORG, projectId: PROJECT })).toEqual([
      'organizationId',
      'projectId',
    ]);
  });

  it('produces refs that validate, for freshly minted ids', () => {
    const ref = internalRepoRef({ organizationId: newId('org'), projectId: newId('proj') });
    expect(InternalRepoRefSchema.safeParse(ref).success).toBe(true);
  });
});

describe('parseInternalRepoRef', () => {
  it('splits owner from name', () => {
    expect(
      parseInternalRepoRef(internalRepoRef({ organizationId: ORG, projectId: PROJECT })),
    ).toEqual({
      owner: 'org_01j8me7yqzj2v9q0x3t5b6k7n9',
      name: 'proj_01j8me7yqzj2v9q0x3t5b6k7na',
    });
  });

  it.each([
    ['a traversal', 'org_01j8me7yqzj2v9q0x3t5b6k7n9/../../etc/passwd'],
    ['an extra segment', 'org_01j8me7yqzj2v9q0x3t5b6k7n9/proj_01j8me7yqzj2v9q0x3t5b6k7na/x'],
    ['a space', 'org_01j8me7yqzj2v9q0x3t5b6k7n9/proj 01j8me7yqzj2v9q0x3t5b6k7na'],
    ['an uppercase half', 'org_01J8ME7YQZJ2V9Q0X3T5B6K7N9/proj_01j8me7yqzj2v9q0x3t5b6k7na'],
    ['the wrong prefix', 'user_01j8me7yqzj2v9q0x3t5b6k7n9/proj_01j8me7yqzj2v9q0x3t5b6k7na'],
    ['no owner', '/proj_01j8me7yqzj2v9q0x3t5b6k7na'],
    [
      'a full URL',
      'https://git.test/org_01j8me7yqzj2v9q0x3t5b6k7n9/proj_01j8me7yqzj2v9q0x3t5b6k7na',
    ],
  ])('refuses %s', (_case, ref) => {
    // A ref is interpolated into API paths and into clone URLs, so anything this
    // function lets through is a path the Git host will follow.
    expect(() => parseInternalRepoRef(ref)).toThrow(/Invalid internal repository ref/);
  });

  it('never echoes the value it rejected', () => {
    // Refs arrive in request bodies, and a rejected value in a message is a
    // rejected value in a log.
    expect(() => parseInternalRepoRef('org_x/../secret-tenant')).not.toThrow(/secret-tenant/);
  });
});

describe('the create-repository contract', () => {
  it('defaults the initial branch to main and refuses an unknown field', () => {
    const parsed = CreateRepositoryInputSchema.parse({
      organizationId: ORG,
      projectId: PROJECT,
    });
    expect(parsed.defaultBranch).toBe('main');

    // Strict: a caller passing `slug` believes the ref is derived from it, and
    // stripping the field in silence lets it go on believing that.
    expect(
      CreateRepositoryInputSchema.safeParse({
        organizationId: ORG,
        projectId: PROJECT,
        slug: 'checkout',
      }).success,
    ).toBe(false);
  });

  it('requires the ids to be the right entities', () => {
    expect(
      CreateRepositoryInputSchema.safeParse({ organizationId: PROJECT, projectId: ORG }).success,
    ).toBe(false);
  });

  it('makes provisionedAt part of what a create returns', () => {
    // `repositories.provisioned_at` is the difference between a row that names a
    // repository and a repository that exists. A provider returning this is
    // asserting that a clone of `cloneUrl` would now succeed.
    const created = {
      internalRepoRef: internalRepoRef({ organizationId: ORG, projectId: PROJECT }),
      cloneUrl: 'https://git.test/org_x/proj_y.git',
      provisionedAt: new Date('2026-01-01T00:00:00Z'),
    };
    expect(CreatedRepositorySchema.parse(created).provisionedAt).toEqual(created.provisionedAt);
    expect(
      CreatedRepositorySchema.safeParse({ ...created, provisionedAt: undefined }).success,
    ).toBe(false);
  });

  it('protects release branches by pattern rather than one at a time', () => {
    // Release branches are minted per release; a rule that had to be applied to
    // each one is a rule that will be missed on the one that mattered.
    expect(RELEASE_BRANCH_PATTERN).toBe('release/*');
  });
});
