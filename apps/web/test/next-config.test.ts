import { strict as assert } from 'node:assert';
import { after, before, it } from 'node:test';

const environment: Record<string, string | undefined> = process.env;
const originalNodeEnv = environment['NODE_ENV'];
const originalControlApiUrl = environment['NEXT_PUBLIC_CONTROL_API_URL'];

before(() => {
  environment['NODE_ENV'] = 'development';
  delete environment['NEXT_PUBLIC_CONTROL_API_URL'];
});

after(() => {
  if (originalNodeEnv === undefined) delete environment['NODE_ENV'];
  else environment['NODE_ENV'] = originalNodeEnv;

  if (originalControlApiUrl === undefined) delete environment['NEXT_PUBLIC_CONTROL_API_URL'];
  else environment['NEXT_PUBLIC_CONTROL_API_URL'] = originalControlApiUrl;
});

void it('connects next dev to the real local control API when no override is supplied', async () => {
  const { default: nextConfig } = await import('../next.config.js');

  assert.equal(nextConfig.env?.NEXT_PUBLIC_CONTROL_API_URL, 'http://localhost:4000');
});
