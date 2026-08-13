import { access, writeFile } from 'node:fs/promises';

import { idSchema } from '@zapp/contracts';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createGitBundleExporter,
  type GitBundleCredentialPort,
} from '../src/export.js';
import { harness, serviceToken, type Harness } from './support/harness.js';

const organizationId = idSchema('org').parse(`org_${'0'.repeat(26)}`);
const projectId = idSchema('proj').parse(`proj_${'1'.repeat(26)}`);
const harnesses: Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.app.close()));
});

class Credentials implements GitBundleCredentialPort {
  readonly calls: string[] = [];

  mintRead() {
    this.calls.push('mint');
    return Promise.resolve({
      username: 'zt-1900000000-0123456789ab',
      token: 'git-token-sentinel',
      cloneUrl: 'https://git.zapp.test/org/repository.git',
    });
  }

  revoke(input: { readonly username: string }) {
    this.calls.push(`revoke:${input.username}`);
    return Promise.resolve();
  }
}

describe('CP-18 verified Git bundle export', () => {
  it('creates and verifies exact bundle bytes, then revokes and removes scratch state', async () => {
    const credentials = new Credentials();
    let bundlePath = '';
    const exporter = createGitBundleExporter({
      credentials,
      commands: () => ({
        async createBundle(_cloneUrl, path) {
          bundlePath = path;
          await writeFile(path, 'portable git history');
        },
        verifyBundle(path) {
          expect(path).toBe(bundlePath);
          return Promise.resolve();
        },
      }),
    });

    await expect(
      exporter.bundle({ organizationId, projectId, operationKey: `op_${'2'.repeat(64)}` }),
    ).resolves.toEqual(Buffer.from('portable git history'));
    expect(credentials.calls).toEqual(['mint', 'revoke:zt-1900000000-0123456789ab']);
    await expect(access(bundlePath)).rejects.toThrow();
  });

  it('revokes and redacts the credential when Git verification fails', async () => {
    const credentials = new Credentials();
    const exporter = createGitBundleExporter({
      credentials,
      commands: () => ({
        createBundle: (_cloneUrl, path) => writeFile(path, 'unverified'),
        verifyBundle: () => Promise.reject(new Error('provider mentioned git-token-sentinel')),
      }),
    });

    const result = exporter.bundle({
      organizationId,
      projectId,
      operationKey: `op_${'3'.repeat(64)}`,
    });
    await expect(result).rejects.toThrow('Git bundle export failed');
    await expect(result).rejects.not.toThrow('git-token-sentinel');
    expect(credentials.calls).toEqual(['mint', 'revoke:zt-1900000000-0123456789ab']);
  });

  it('serves bytes only to a control-api service token at the derived tenant/project route', async () => {
    const built = harness({
      bundleExporter: {
        bundle: (input) => {
          expect(input).toMatchObject({ organizationId, projectId });
          return Promise.resolve(Buffer.from('wire bundle'));
        },
      },
    });
    harnesses.push(built);
    const token = await serviceToken('control-api');

    const response = await built.app.inject({
      method: 'POST',
      url: `/internal/git/repositories/${organizationId}/${projectId}/export-bundle`,
      headers: {
        'x-zapp-service-token': token,
        'idempotency-key': 'cp18-wire-bundle',
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('application/x-git-bundle');
    expect(response.rawPayload).toEqual(Buffer.from('wire bundle'));
    const sandboxToken = await serviceToken('sandbox-service');
    const refused = await built.app.inject({
      method: 'POST',
      url: `/internal/git/repositories/${organizationId}/${projectId}/export-bundle`,
      headers: {
        'x-zapp-service-token': sandboxToken,
        'idempotency-key': 'cp18-wire-refused',
      },
    });
    expect(refused.statusCode).toBe(403);
  });
});
