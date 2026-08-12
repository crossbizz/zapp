import { describe, expect, it } from 'vitest';

import {
  GitTemplateSeedConflictError,
  createGitTemplateSeeder,
} from '../src/template-seeder.js';
import type { GitCommandInput, GitCommandRunner } from '../src/import/git.js';

const SOURCE_SHA = 'a57bb2926674275a84f651c64e5c995a42519b5e';

class FakeRunner implements GitCommandRunner {
  readonly calls: GitCommandInput[] = [];
  targetState = '';

  run(input: GitCommandInput): Promise<{ stdout: string }> {
    this.calls.push(input);
    if (input.args[0] === 'rev-parse') return Promise.resolve({ stdout: `${SOURCE_SHA}\n` });
    if (input.args[0] === 'ls-remote') return Promise.resolve({ stdout: this.targetState });
    return Promise.resolve({ stdout: '' });
  }
}

const input = {
  sourceCloneUrl: 'https://github.com/dyad-sh/nextjs-template.git',
  sourceCommitSha: SOURCE_SHA,
  targetCloneUrl: 'https://git.test/org_x/proj_y.git',
  targetUsername: 'scoped-user',
  targetToken: 'secret-target-token',
  targetBranch: 'main',
};

describe('GIT-5 exact approved-template seeder', () => {
  it('fetches the exact immutable source and pushes only an empty target branch', async () => {
    const runner = new FakeRunner();
    const seeder = createGitTemplateSeeder({ runner });

    await expect(seeder.seed(input)).resolves.toEqual({ headCommitSha: SOURCE_SHA });

    expect(runner.calls.map(({ args }) => args)).toEqual(expect.arrayContaining([
      ['init', '--quiet', '--initial-branch=main', expect.any(String)],
      ['fetch', '--depth=1', 'source', SOURCE_SHA],
      ['checkout', '--quiet', '--detach', 'FETCH_HEAD'],
      ['push', 'target', 'HEAD:refs/heads/main'],
    ]));
    expect(JSON.stringify(runner.calls.map(({ args }) => args))).not.toContain('secret-target-token');
  });

  it('recovers an equal retry without pushing and rejects divergent target history', async () => {
    const equal = new FakeRunner();
    equal.targetState = `${SOURCE_SHA}\trefs/heads/main\n`;
    const equalSeeder = createGitTemplateSeeder({ runner: equal });
    await expect(equalSeeder.seed(input)).resolves.toEqual({ headCommitSha: SOURCE_SHA });
    expect(equal.calls.some(({ args }) => args[0] === 'push')).toBe(false);

    const divergent = new FakeRunner();
    divergent.targetState = `${'b'.repeat(40)}\trefs/heads/main\n`;
    await expect(createGitTemplateSeeder({ runner: divergent }).seed(input)).rejects.toBeInstanceOf(
      GitTemplateSeedConflictError,
    );
    expect(divergent.calls.some(({ args }) => args[0] === 'push')).toBe(false);
  });
});
