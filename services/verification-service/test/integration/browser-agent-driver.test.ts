import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AccessibilitySnapshotResultSchema,
  ClickResultSchema,
  ConsoleResultSchema,
  FailedRequestsResultSchema,
  FillResultSchema,
  InteractiveElementsResultSchema,
  PlaywrightBrowserAgentDriver,
  VisibleTextResultSchema,
} from '../../src/browser-agent/driver.js';

describe('VF-11 Playwright browser-agent driver', () => {
  let browser: Browser;
  let page: Page;
  let driver: PlaywrightBrowserAgentDriver;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.route('https://app.example.test/fail', async (route) => {
      await route.fulfill({
        status: 503,
        contentType: 'text/plain',
        headers: { 'access-control-allow-origin': '*' },
        body: 'unavailable',
      });
    });
    await page.setContent(`
      <!doctype html>
      <html>
        <body>
          <main aria-label="Profile settings">
            <h1>Profile</h1>
            <label>Name <input aria-label="Name" /></label>
            <button type="button" onclick="document.querySelector('#status').textContent='Saved'">
              Save profile
            </button>
            <p id="status" aria-live="polite"></p>
          </main>
        </body>
      </html>
    `);
    driver = new PlaywrightBrowserAgentDriver(page);
  });

  afterAll(async () => {
    driver.dispose();
    await page.close({ runBeforeUnload: false });
    await browser.close();
  }, 30_000);

  it('drives DOM and accessibility primitives through opaque interactive refs', async () => {
    const accessibility = AccessibilitySnapshotResultSchema.parse(
      (await driver.snapshotAccessibilityTree()).modelValue,
    );
    expect(accessibility.snapshot).toContain('Profile');

    const listed = InteractiveElementsResultSchema.parse(
      (await driver.listInteractive()).modelValue,
    );
    expect(listed.elements).toHaveLength(2);
    expect(new Set(listed.elements.map((element) => element.ref)).size).toBe(2);

    const input = listed.elements.find((element) => element.name === 'Name');
    const button = listed.elements.find((element) => element.name === 'Save profile');
    expect(input).toBeDefined();
    expect(button).toBeDefined();

    const filled = FillResultSchema.parse((await driver.fill(input?.ref ?? '', 'Ada')).modelValue);
    expect(filled).toEqual({ ref: input?.ref, filled: true });
    expect(await page.getByLabel('Name').inputValue()).toBe('Ada');

    const clicked = ClickResultSchema.parse((await driver.click(button?.ref ?? '')).modelValue);
    expect(clicked).toMatchObject({ ref: button?.ref, clicked: true });
    expect(
      VisibleTextResultSchema.parse((await driver.expectVisibleText('Saved')).modelValue),
    ).toEqual({ text: 'Saved', visible: true, matchCount: 1 });
  });

  it('captures console, network, and PNG evidence without treating the image as an assertion', async () => {
    await page.evaluate(() => {
      console.error('critical console fault');
    });
    await page.evaluate(async () => {
      await fetch('https://app.example.test/fail');
    });

    const consoleEntries = ConsoleResultSchema.parse((await driver.readConsole()).modelValue);
    expect(consoleEntries.entries).toContainEqual(
      expect.objectContaining({ level: 'error', text: 'critical console fault' }),
    );

    const failedRequests = FailedRequestsResultSchema.parse(
      (await driver.readFailedRequests()).modelValue,
    );
    expect(failedRequests.requests).toContainEqual(
      expect.objectContaining({ url: 'https://app.example.test/fail', status: 503 }),
    );

    const screenshot = await driver.screenshot('profile-saved');
    expect(screenshot.source).toBe('screenshot');
    expect(screenshot.attachment).toMatchObject({ contentType: 'image/png' });
    expect([...(screenshot.attachment?.body.slice(0, 8) ?? [])]).toEqual([
      137, 80, 78, 71, 13, 10, 26, 10,
    ]);

    driver.resetFlowState();
    expect(ConsoleResultSchema.parse((await driver.readConsole()).modelValue)).toEqual({
      entries: [],
    });
    expect(
      FailedRequestsResultSchema.parse((await driver.readFailedRequests()).modelValue),
    ).toEqual({ requests: [] });
  });
});
