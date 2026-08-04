import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { defineConfig } from 'drizzle-kit';

// drizzle-kit runs with this package as cwd, and nothing else loads the repo's
// .env for it — scripts/dev-up.sh calls `pnpm db:migrate` with a bare
// environment. A real environment variable always wins; the file is only a
// local-development fallback, and the connection string is never hardcoded.
const repoEnvFile = resolve(process.cwd(), '../../.env');
if (!process.env.DATABASE_URL && existsSync(repoEnvFile)) {
  process.loadEnvFile(repoEnvFile);
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is not set — start the dev stack with ./scripts/dev-up.sh');
}

export default defineConfig({
  // Glob rather than the barrel: a new domain module is picked up without
  // editing this file, and one that forgets to re-export still gets a migration.
  schema: './src/schema/*',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
});
