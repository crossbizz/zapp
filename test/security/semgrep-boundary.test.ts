import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const policyPath = fileURLToPath(new URL('../../.semgrep/zapp-policies.yml', import.meta.url));

describe('OPS-13 child-process runtime boundary', () => {
  it('allowlists runtime-owning packages and only the exact non-package command owners', async () => {
    const policy = await readFile(policyPath, 'utf8');
    const childProcessPolicy = policy.slice(
      policy.indexOf('  - id: zapp.child-process-runtime-boundary'),
      policy.indexOf('  - id: zapp.modal-sdk-boundary'),
    );

    expect(childProcessPolicy).toContain("        - '/services/sandbox-service/**'");
    expect(childProcessPolicy).toContain(
      "        - '/services/control-api/src/integrations/github/git-runtime.ts'",
    );
    expect(childProcessPolicy).toContain("        - '/validation/exit-criteria/validate.mjs'");
    expect(childProcessPolicy).not.toContain("        - '/services/control-api/**'");
    expect(childProcessPolicy).not.toContain("        - '/validation/**'");
  });
});
