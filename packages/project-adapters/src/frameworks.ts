export { astroAdapter } from './astro.js';
export { capacitorAdapter } from './capacitor.js';
export { expressFastifyAdapter } from './express-fastify.js';
export type { FrameworkAdapter } from './framework-shared.js';
export { nestAdapter } from './nest.js';
export { nextAdapter } from './next.js';
export { nuxtAdapter } from './nuxt.js';
export { reactAdapter } from './react.js';
export { svelteKitAdapter } from './sveltekit.js';
export { viteAdapter } from './vite.js';

import { astroAdapter } from './astro.js';
import { capacitorAdapter } from './capacitor.js';
import { expressFastifyAdapter } from './express-fastify.js';
import type { FrameworkAdapter } from './framework-shared.js';
import { nestAdapter } from './nest.js';
import { nextAdapter } from './next.js';
import { nuxtAdapter } from './nuxt.js';
import { reactAdapter } from './react.js';
import { svelteKitAdapter } from './sveltekit.js';
import { viteAdapter } from './vite.js';

export const frameworkAdapters: readonly FrameworkAdapter[] = [
  nextAdapter,
  nuxtAdapter,
  svelteKitAdapter,
  astroAdapter,
  viteAdapter,
  reactAdapter,
  expressFastifyAdapter,
  nestAdapter,
  capacitorAdapter,
];
