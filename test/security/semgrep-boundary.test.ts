import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const policyPath = fileURLToPath(
  new URL('../../.semgrep/zapp-policies.yml', import.meta.url),
);

describe('OPS-13 child-process runtime boundary', () => {
  it('allowlists only the exact non-package command owners', async () => {
    const policy = await readFile(policyPath, 'utf8');

    expect(policy).toContain(
      "        - '/services/control-api/src/integrations/github/git-runtime.ts'",
    );
    expect(policy).toContain("        - '/validation/exit-criteria/validate.mjs'");
    expect(policy).not.toContain("        - '/services/control-api/**'");
    expect(policy).not.toContain("        - '/validation/**'");
  });
});
