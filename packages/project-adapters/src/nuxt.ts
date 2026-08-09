import { createFrameworkAdapter, discoverNuxtRoutes } from './framework-shared.js';

export const nuxtAdapter = createFrameworkAdapter({
  id: 'nuxt',
  configPatterns: [/^nuxt\.config\.[cm]?[jt]s$/u],
  dependencies: ['nuxt'],
  defaultPort: 3000,
  buildOutput: '.output',
  deploymentProvider: 'fly',
  discoverRoutes: discoverNuxtRoutes,
});
