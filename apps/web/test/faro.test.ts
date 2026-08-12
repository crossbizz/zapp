import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildWebFaroConfig, installWebFaroBundleId } from '../src/observability/faro-config.js';

void describe('web Faro configuration', () => {
  void it('stays disabled when no public collector URL is configured', () => {
    assert.equal(buildWebFaroConfig({}), null);
    assert.equal(
      buildWebFaroConfig({
        NEXT_PUBLIC_FARO_URL: '',
        NEXT_PUBLIC_ZAPP_ENV: '',
        NEXT_PUBLIC_ZAPP_RELEASE: '',
        NEXT_PUBLIC_FARO_BUNDLE_ID: '',
      }),
      null,
    );
  });

  void it('tags errors and web vitals with the exact release and source-map bundle', () => {
    assert.deepEqual(
      buildWebFaroConfig({
        NEXT_PUBLIC_FARO_URL: 'https://faro.example.test/collect/app-key',
        NEXT_PUBLIC_ZAPP_ENV: 'staging',
        NEXT_PUBLIC_ZAPP_RELEASE: 'release-42',
        NEXT_PUBLIC_FARO_BUNDLE_ID: 'bundle-42',
      }),
      {
        url: 'https://faro.example.test/collect/app-key',
        app: {
          name: 'zapp-web',
          namespace: 'zapp',
          version: 'release-42',
          environment: 'staging',
        },
        bundleId: 'bundle-42',
      },
    );
  });

  void it('rejects a partial enabled configuration', () => {
    assert.throws(
      () =>
        buildWebFaroConfig({
          NEXT_PUBLIC_FARO_URL: 'https://faro.example.test/collect/app-key',
        }),
      /NEXT_PUBLIC_ZAPP_RELEASE/u,
    );
  });

  void it('installs the source-map bundle identity before Faro initializes', () => {
    const target: Record<string, unknown> = {};
    const config = buildWebFaroConfig({
      NEXT_PUBLIC_FARO_URL: 'https://faro.example.test/collect/app-key',
      NEXT_PUBLIC_ZAPP_ENV: 'production',
      NEXT_PUBLIC_ZAPP_RELEASE: 'release-42',
      NEXT_PUBLIC_FARO_BUNDLE_ID: 'bundle-42',
    });
    if (config === null) assert.fail('expected enabled Faro config');

    installWebFaroBundleId(config, target);

    assert.equal(target['__faroBundleId_zapp-web'], 'bundle-42');
  });
});
