/**
 * Brings a Forgejo instance to the state plan 06 assumes, and says what it did
 * (GIT-1).
 *
 *   FORGEJO_URL=… FORGEJO_ADMIN_TOKEN=… pnpm --filter @zapp/git-service bootstrap
 *
 * In dev the two variables come from `.env.local.forgejo`, which
 * `scripts/dev-up.sh` writes and the `bootstrap` script loads automatically. In a
 * deployment they come from `terraform output forgejo_internal_url` and a Fly
 * secret.
 *
 * Everything this file does beyond reading the environment and printing is in
 * `src/forgejo/bootstrap.ts`, where a test can drive it. This is the half that
 * cannot be tested — the process boundary — and it is deliberately the smaller
 * half.
 *
 * Exit codes: 0 for success (whether or not anything changed), 1 for an
 * instance that is not usable. A CI step can treat "changed" as normal on a
 * first deploy and as a question worth asking on a later one.
 */
import { createForgejoClient } from '../src/forgejo/client.js';
import { BootstrapError, bootstrapForgejo } from '../src/forgejo/bootstrap.js';
import { loadForgejoEnv } from '../src/env.js';

function fail(message: string): never {
  process.stderr.write(`\u001b[1;31m[fail]\u001b[0m ${message}\n`);
  process.exit(1);
}

let forgejo;
try {
  forgejo = loadForgejoEnv();
} catch (error) {
  // `defineEnv` names the variables and never their values, so this is safe to
  // print verbatim.
  fail(error instanceof Error ? error.message : 'the environment could not be read');
}

const client = createForgejoClient(forgejo);

try {
  const report = await bootstrapForgejo(client);
  for (const step of report.steps) {
    const mark = step.outcome === 'created' ? '\u001b[1;33m+\u001b[0m' : '\u001b[1;32m✓\u001b[0m';
    process.stdout.write(
      `${mark} ${step.name.padEnd(20)} ${step.outcome.padEnd(8)} ${step.detail}\n`,
    );
  }
  process.stdout.write(
    report.unchanged
      ? '\n\u001b[1;32m==>\u001b[0m already bootstrapped — nothing changed\n'
      : '\n\u001b[1;34m==>\u001b[0m bootstrap complete\n',
  );
} catch (error) {
  if (error instanceof BootstrapError) {
    // A stack trace here would be noise: the message is the finding, and the
    // cause is a Forgejo status code that the message already names.
    fail(error.message);
  }
  fail(error instanceof Error ? error.message : 'bootstrap failed');
}
