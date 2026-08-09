import { createFrameworkAdapter } from './framework-shared.js';

export const capacitorAdapter = createFrameworkAdapter({
  id: 'capacitor',
  configPatterns: [/^capacitor\.config\.[cm]?[jt]s$/u, /^capacitor\.config\.json$/u],
  dependencies: ['@capacitor/core'],
  defaultPort: 5173,
  buildOutput: 'dist',
  deploymentProvider: null,
  preservePaths: ['android', 'ios'],
  supportsStoreRelease: false,
});
