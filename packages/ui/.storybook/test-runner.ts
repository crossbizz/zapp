import { checkA11y, injectAxe } from 'axe-playwright';
import type { TestRunnerConfig } from '@storybook/test-runner';

const storyAndPortalSelectors = [
  '#storybook-root',
  '.zapp-dialog',
  '.zapp-drawer',
  '.zapp-tooltip',
] as const;

const config: TestRunnerConfig = {
  async postVisit(page) {
    await injectAxe(page);
    const mountedAuditRoots = await page.evaluate(
      (selectors) => selectors.filter((selector) => document.querySelector(selector) !== null),
      storyAndPortalSelectors,
    );
    await checkA11y(
      page,
      { include: mountedAuditRoots },
      {
        detailedReport: true,
        detailedReportOptions: { html: true },
      },
    );
  },
};

export default config;
