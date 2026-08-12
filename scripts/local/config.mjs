import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REQUIRED_PROVIDER_VARIABLES = [
  'STYTCH_PROJECT_ID',
  'STYTCH_SECRET',
  'STYTCH_PUBLIC_TOKEN',
  'ANTHROPIC_API_KEY',
  'MODAL_TOKEN_ID',
  'MODAL_TOKEN_SECRET',
];

export class LocalPreflightError extends Error {
  constructor(message, variables = []) {
    super(message);
    this.name = 'LocalPreflightError';
    this.variables = [...variables].sort();
  }
}

function parseEnvFile(contents) {
  const parsed = {};
  for (const line of contents.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const name = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    parsed[name] = value;
  }
  return parsed;
}

function missingCredential(value) {
  return typeof value !== 'string' || value.trim() === '' || /replace-me/iu.test(value);
}

function readJson(path, name) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new LocalPreflightError(`${name} is missing or invalid`);
  }
}

function validateImageLock(value) {
  const dev = value?.environments?.dev;
  if (dev?.modalEnvironment !== 'zapp-dev') {
    throw new LocalPreflightError('The dev Modal image lock must target zapp-dev');
  }
  const names = ['forge-node-base', 'forge-web-test'];
  const images = names.map((name) => {
    const image = dev.images?.[name];
    if (
      typeof image?.digest !== 'string' ||
      image.digest === '' ||
      typeof image?.publishedName !== 'string' ||
      image.publishedName === '' ||
      image.publishedName.endsWith(':latest')
    ) {
      throw new LocalPreflightError(`The ${name} dev image lock must be immutable`);
    }
    return {
      name,
      digest: image.digest,
      publishedName: image.publishedName,
    };
  });
  return { modalEnvironment: dev.modalEnvironment, images };
}

export function loadLocalConfig({
  cwd = process.cwd(),
  env = process.env,
  argv = process.argv.slice(2),
  envPath = resolve(cwd, '.env'),
  packagePath = resolve(cwd, 'package.json'),
  imageLockPath = resolve(cwd, 'infra/modal/images.lock.json'),
} = {}) {
  const unknown = argv.filter((argument) => argument !== '--no-open');
  if (unknown.length > 0) {
    throw new LocalPreflightError(`Unknown local option: ${unknown.join(', ')}`);
  }
  let fileEnv;
  try {
    fileEnv = parseEnvFile(readFileSync(envPath, 'utf8'));
  } catch {
    throw new LocalPreflightError('Root .env is missing; run ./scripts/dev-up.sh once');
  }
  const packageJson = readJson(packagePath, 'package.json');
  if (packageJson.packageManager !== 'pnpm@9.15.0') {
    throw new LocalPreflightError('package.json must pin pnpm@9.15.0');
  }
  const combined = {
    ...fileEnv,
    ...env,
    NODE_ENV: 'development',
    RUN_WORKFLOW_PROFILE: 'm1',
    NEXT_PUBLIC_CONTROL_API_URL: 'http://127.0.0.1:4000',
  };
  const missing = REQUIRED_PROVIDER_VARIABLES.filter((name) => missingCredential(combined[name]));
  if (missing.length > 0) {
    throw new LocalPreflightError(
      `Local M1 provider configuration is missing: ${missing.sort().join(', ')}`,
      missing,
    );
  }
  const imageLock = validateImageLock(readJson(imageLockPath, 'Modal image lock'));
  const redactions = REQUIRED_PROVIDER_VARIABLES.map((name) => combined[name]).filter(
    (value) => typeof value === 'string' && value !== '',
  );
  for (const name of [
    'SESSION_JWT_SECRET',
    'SERVICE_TOKEN_SECRET',
    'RUN_INTENT_HMAC_SECRET',
    'SECRETS_MASTER_KEY',
  ]) {
    if (typeof combined[name] === 'string' && combined[name] !== '')
      redactions.push(combined[name]);
  }
  return {
    cwd: resolve(cwd),
    env: combined,
    redactions,
    openBrowser: !argv.includes('--no-open'),
    ports: [3000, 4000, 4100, 4400, 4500],
    imageLock,
  };
}
