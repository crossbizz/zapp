/* eslint-disable @typescript-eslint/no-require-imports -- Storybook loads ejected Jest config through CommonJS. */
const path = require('node:path');
const { getJestConfig } = require('@storybook/test-runner');

const testRunnerConfig = getJestConfig();

module.exports = {
  ...testRunnerConfig,
  rootDir: path.resolve(__dirname, '..'),
};
