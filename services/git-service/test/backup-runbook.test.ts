import { execFile } from 'node:child_process';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../scripts/restore-evidence.sh', import.meta.url));
const runbookPath = fileURLToPath(
  new URL('../../../docs/runbooks/git-restore.md', import.meta.url),
);
const temporaryDirectories: string[] = [];

const matchingEvidence = JSON.stringify({
  status: 'restored',
  checkedBranches: 1,
  branches: [{ name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'a'.repeat(40) }],
  refs: [{ name: 'refs/heads/main', sha: 'a'.repeat(40) }],
});

async function runScript(
  mode: 'valid' | 'banner' | 'producer-failure' | 'sha-mismatch',
  options: { readonly preexistingEvidence?: string } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'zapp-restore-runbook-'));
  temporaryDirectories.push(directory);
  const fakeBin = join(directory, 'bin');
  await mkdir(fakeBin);
  const fakePnpm = join(fakeBin, 'pnpm');
  await writeFile(
    fakePnpm,
    `#!/usr/bin/env bash
set -euo pipefail
case "$FAKE_PNPM_MODE" in
  valid) printf '%s\\n' "$FAKE_EVIDENCE" ;;
  banner) printf 'pnpm banner\\n%s\\n' "$FAKE_EVIDENCE" ;;
  producer-failure) printf '%s\\n' "$FAKE_EVIDENCE"; exit 23 ;;
  sha-mismatch) printf '%s\\n' "$FAKE_MISMATCH_EVIDENCE" ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(fakePnpm, 0o700);
  const evidence = join(directory, 'evidence.json');
  if (options.preexistingEvidence !== undefined) {
    await writeFile(evidence, options.preexistingEvidence);
  }
  const mismatch = JSON.stringify({
    ...JSON.parse(matchingEvidence),
    branches: [{ name: 'main', expectedSha: 'a'.repeat(40), actualSha: 'b'.repeat(40) }],
  });
  return {
    directory,
    evidence,
    result: execute('bash', [scriptPath, evidence], {
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
        FAKE_PNPM_MODE: mode,
        FAKE_EVIDENCE: matchingEvidence,
        FAKE_MISMATCH_EVIDENCE: mismatch,
      },
    }),
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true });
    }),
  );
});

describe('the executable Git restore runbook', () => {
  it('saves exactly one JSON document and validates every expected/actual branch SHA', async () => {
    const execution = await runScript('valid');
    await expect(execution.result).resolves.toMatchObject({ stderr: '' });
    expect(JSON.parse(await readFile(execution.evidence, 'utf8'))).toEqual(
      JSON.parse(matchingEvidence),
    );
    expect((await readdir(execution.directory)).filter((name) => name.includes('.tmp.'))).toEqual(
      [],
    );
  });

  it('rejects pnpm banners instead of accepting mixed output as evidence', async () => {
    const execution = await runScript('banner');
    await expect(execution.result).rejects.toBeInstanceOf(Error);
    await expect(access(execution.evidence)).rejects.toThrow();
    expect((await readdir(execution.directory)).filter((name) => name.includes('.tmp.'))).toEqual(
      [],
    );
  });

  it('preserves the real CLI producer exit status', async () => {
    const execution = await runScript('producer-failure');
    await expect(execution.result).rejects.toMatchObject({ code: 23 });
    await expect(access(execution.evidence)).rejects.toThrow();
    expect((await readdir(execution.directory)).filter((name) => name.includes('.tmp.'))).toEqual(
      [],
    );
  });

  it('exits nonzero when any expected and actual SHA differ', async () => {
    const execution = await runScript('sha-mismatch');
    await expect(execution.result).rejects.toMatchObject({ code: 1 });
    await expect(access(execution.evidence)).rejects.toThrow();
    expect((await readdir(execution.directory)).filter((name) => name.includes('.tmp.'))).toEqual(
      [],
    );
  });

  it('refuses to overwrite pre-existing incident evidence', async () => {
    const original = '{"incident":"preserve"}\n';
    const execution = await runScript('valid', { preexistingEvidence: original });

    await expect(execution.result).rejects.toMatchObject({ code: 73 });
    expect(await readFile(execution.evidence, 'utf8')).toBe(original);
    expect((await readdir(execution.directory)).filter((name) => name.includes('.tmp.'))).toEqual(
      [],
    );
  });

  it('documents the strict executable wrapper rather than a display pipeline', async () => {
    const runbook = await readFile(runbookPath, 'utf8');
    expect(runbook).toContain('```bash\n');
    expect(runbook).toContain('scripts/restore-evidence.sh "$restore_evidence"');
    expect(runbook).not.toContain('| tee "$restore_evidence"');
  });
});
