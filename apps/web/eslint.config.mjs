import nextPlugin from '@next/eslint-plugin-next';

import rootConfig from '../../eslint.config.mjs';

export default [
  ...rootConfig,
  {
    plugins: { '@next/next': nextPlugin },
    rules: nextPlugin.configs.recommended.rules,
  },
  { ignores: ['next-env.d.ts'] },
];
