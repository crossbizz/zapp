import type { ConsoleMessage, Locator, Page, Request, Response } from '@playwright/test';
import { z } from 'zod';

const MAX_INTERACTIVE_ELEMENTS = 200;
const MAX_CAPTURED_ENTRIES = 500;

export const BrowserPrimitiveSourceSchema = z.enum([
  'dom',
  'accessibility',
  'network',
  'console',
  'screenshot',
]);
export type BrowserPrimitiveSource = z.infer<typeof BrowserPrimitiveSourceSchema>;

export const AccessibilitySnapshotResultSchema = z
  .object({ snapshot: z.string().max(512 * 1024) })
  .strict();
export const InteractiveElementSchema = z
  .object({
    ref: z.string().regex(/^element_[1-9][0-9]*$/u),
    tag: z.string().min(1).max(64),
    role: z.string().min(1).max(128),
    name: z.string().max(512),
    disabled: z.boolean(),
  })
  .strict();
export const InteractiveElementsResultSchema = z
  .object({ elements: z.array(InteractiveElementSchema).max(MAX_INTERACTIVE_ELEMENTS) })
  .strict();
export const ClickResultSchema = z
  .object({
    ref: InteractiveElementSchema.shape.ref,
    clicked: z.literal(true),
    url: z.string().url(),
  })
  .strict();
export const FillResultSchema = z
  .object({ ref: InteractiveElementSchema.shape.ref, filled: z.literal(true) })
  .strict();
export const VisibleTextResultSchema = z
  .object({
    text: z.string().min(1).max(2_048),
    visible: z.literal(true),
    matchCount: z.number().int().positive(),
  })
  .strict();
const ConsoleEntrySchema = z
  .object({
    level: z.enum(['debug', 'info', 'log', 'warning', 'error']),
    text: z.string().max(64 * 1024),
    url: z.string().max(8_192),
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
  })
  .strict();
export const ConsoleResultSchema = z
  .object({ entries: z.array(ConsoleEntrySchema).max(MAX_CAPTURED_ENTRIES) })
  .strict();
const FailedRequestSchema = z
  .object({
    url: z.string().max(8_192),
    method: z.string().min(1).max(32),
    resourceType: z.string().min(1).max(128),
    status: z.number().int().min(400).max(599).nullable(),
    reason: z.string().max(4_096).nullable(),
  })
  .strict();
export const FailedRequestsResultSchema = z
  .object({ requests: z.array(FailedRequestSchema).max(MAX_CAPTURED_ENTRIES) })
  .strict();
const ScreenshotResultSchema = z.object({ label: z.string().min(1).max(128) }).strict();

const BrowserPrimitiveModelValueSchema = z.union([
  AccessibilitySnapshotResultSchema,
  InteractiveElementsResultSchema,
  ClickResultSchema,
  FillResultSchema,
  VisibleTextResultSchema,
  ConsoleResultSchema,
  FailedRequestsResultSchema,
  ScreenshotResultSchema,
]);
const BrowserEvidenceAttachmentSchema = z
  .object({
    contentType: z.literal('image/png'),
    body: z.instanceof(Uint8Array),
  })
  .strict();
export const BrowserPrimitiveObservationSchema = z
  .object({
    source: BrowserPrimitiveSourceSchema,
    label: z.string().min(1).max(256),
    modelValue: BrowserPrimitiveModelValueSchema,
    attachment: BrowserEvidenceAttachmentSchema.optional(),
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.source === 'screenshot' && observation.attachment === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachment'],
        message: 'Screenshot observations require PNG bytes',
      });
    }
    if (observation.source !== 'screenshot' && observation.attachment !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attachment'],
        message: 'Only screenshot observations may carry binary bytes',
      });
    }
  });
export type BrowserPrimitiveObservation = z.infer<typeof BrowserPrimitiveObservationSchema>;

const EmptyInputSchema = z.object({}).strict();
const RefInputSchema = z.object({ ref: InteractiveElementSchema.shape.ref }).strict();
const FillInputSchema = RefInputSchema.extend({ value: z.string().max(64 * 1024) }).strict();
const VisibleTextInputSchema = z.object({ text: z.string().trim().min(1).max(2_048) }).strict();
const ScreenshotInputSchema = z
  .object({ label: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u) })
  .strict();

export interface BrowserAgentDriver {
  resetFlowState(): void;
  cancelPending(): void;
  snapshotAccessibilityTree(): Promise<BrowserPrimitiveObservation>;
  listInteractive(): Promise<BrowserPrimitiveObservation>;
  click(ref: string): Promise<BrowserPrimitiveObservation>;
  fill(ref: string, value: string): Promise<BrowserPrimitiveObservation>;
  expectVisibleText(text: string): Promise<BrowserPrimitiveObservation>;
  readConsole(): Promise<BrowserPrimitiveObservation>;
  readFailedRequests(): Promise<BrowserPrimitiveObservation>;
  screenshot(label: string): Promise<BrowserPrimitiveObservation>;
}

function observation(
  source: BrowserPrimitiveSource,
  label: string,
  modelValue: z.infer<typeof BrowserPrimitiveModelValueSchema>,
  attachment?: z.infer<typeof BrowserEvidenceAttachmentSchema>,
): BrowserPrimitiveObservation {
  return BrowserPrimitiveObservationSchema.parse({ source, label, modelValue, attachment });
}

function boundedPush<T>(values: T[], value: T): void {
  if (values.length === MAX_CAPTURED_ENTRIES) values.shift();
  values.push(value);
}

function consoleLevel(type: string): z.infer<typeof ConsoleEntrySchema>['level'] {
  if (type === 'warn') return 'warning';
  if (['debug', 'info', 'log', 'error'].includes(type)) {
    return type as z.infer<typeof ConsoleEntrySchema>['level'];
  }
  return 'log';
}

export class PlaywrightBrowserAgentDriver implements BrowserAgentDriver {
  readonly #page: Page;
  readonly #consoleEntries: Array<z.infer<typeof ConsoleEntrySchema>> = [];
  readonly #failedRequests: Array<z.infer<typeof FailedRequestSchema>> = [];
  readonly #interactive = new Map<string, Locator>();

  readonly #onConsole = (message: ConsoleMessage): void => {
    const location = message.location();
    boundedPush(
      this.#consoleEntries,
      ConsoleEntrySchema.parse({
        level: consoleLevel(message.type()),
        text: message.text(),
        url: location.url,
        line: location.lineNumber,
        column: location.columnNumber,
      }),
    );
  };

  readonly #onPageError = (error: Error): void => {
    boundedPush(
      this.#consoleEntries,
      ConsoleEntrySchema.parse({
        level: 'error',
        text: error.message,
        url: this.#page.url(),
        line: 0,
        column: 0,
      }),
    );
  };

  readonly #onResponse = (response: Response): void => {
    if (response.status() < 400) return;
    const request = response.request();
    boundedPush(
      this.#failedRequests,
      FailedRequestSchema.parse({
        url: response.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: response.status(),
        reason: response.statusText() || null,
      }),
    );
  };

  readonly #onRequestFailed = (request: Request): void => {
    boundedPush(
      this.#failedRequests,
      FailedRequestSchema.parse({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: null,
        reason: request.failure()?.errorText ?? 'request_failed',
      }),
    );
  };

  constructor(page: Page) {
    this.#page = page;
    page.on('console', this.#onConsole);
    page.on('pageerror', this.#onPageError);
    page.on('response', this.#onResponse);
    page.on('requestfailed', this.#onRequestFailed);
  }

  dispose(): void {
    this.#page.off('console', this.#onConsole);
    this.#page.off('pageerror', this.#onPageError);
    this.#page.off('response', this.#onResponse);
    this.#page.off('requestfailed', this.#onRequestFailed);
    this.#interactive.clear();
  }

  resetFlowState(): void {
    this.#consoleEntries.length = 0;
    this.#failedRequests.length = 0;
    this.#interactive.clear();
  }

  cancelPending(): void {
    this.dispose();
    void this.#page.close({ runBeforeUnload: false }).catch(() => undefined);
  }

  async snapshotAccessibilityTree(): Promise<BrowserPrimitiveObservation> {
    EmptyInputSchema.parse({});
    const result = AccessibilitySnapshotResultSchema.parse({
      snapshot: await this.#page.locator('body').ariaSnapshot(),
    });
    return observation('accessibility', 'accessibility-tree', result);
  }

  async listInteractive(): Promise<BrowserPrimitiveObservation> {
    EmptyInputSchema.parse({});
    this.#interactive.clear();
    const candidates = this.#page.locator(
      'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], ' +
        '[role="checkbox"], [role="radio"], [role="tab"], [contenteditable="true"]',
    );
    const elements: Array<z.infer<typeof InteractiveElementSchema>> = [];
    const count = Math.min(await candidates.count(), MAX_INTERACTIVE_ELEMENTS);
    for (let index = 0; index < count; index += 1) {
      const locator = candidates.nth(index);
      if (!(await locator.isVisible())) continue;
      const ref = `element_${String(elements.length + 1)}`;
      const description = await locator.evaluate((element) => {
        const tag = element.tagName.toLowerCase();
        const explicitRole = element.getAttribute('role');
        let role = explicitRole ?? tag;
        if (explicitRole === null && tag === 'a') role = 'link';
        if (explicitRole === null && tag === 'button') role = 'button';
        if (explicitRole === null && tag === 'input') {
          const type = (element.getAttribute('type') ?? 'text').toLowerCase();
          role = ['button', 'checkbox', 'radio'].includes(type) ? type : 'textbox';
        }
        const control = element as unknown as {
          readonly labels?: ArrayLike<{ readonly textContent: string | null }> | null;
          readonly disabled?: boolean;
        };
        const label = control.labels?.[0]?.textContent ?? null;
        const name =
          [
            element.getAttribute('aria-label'),
            label,
            element.textContent,
            element.getAttribute('placeholder'),
            element.getAttribute('alt'),
            element.getAttribute('title'),
          ].find(
            (candidate): candidate is string =>
              typeof candidate === 'string' && candidate.trim() !== '',
          ) ?? '';
        const disabled =
          element.getAttribute('aria-disabled') === 'true' || control.disabled === true;
        return { tag, role, name: name.replace(/\s+/gu, ' ').trim().slice(0, 512), disabled };
      });
      this.#interactive.set(ref, locator);
      elements.push(InteractiveElementSchema.parse({ ref, ...description }));
    }
    return observation(
      'dom',
      'interactive-elements',
      InteractiveElementsResultSchema.parse({ elements }),
    );
  }

  async click(refValue: string): Promise<BrowserPrimitiveObservation> {
    const { ref } = RefInputSchema.parse({ ref: refValue });
    const locator = this.#interactive.get(ref);
    if (locator === undefined) throw new Error('browser_agent_unknown_interactive_ref');
    await locator.click();
    return observation(
      'dom',
      `click-${ref}`,
      ClickResultSchema.parse({
        ref,
        clicked: true,
        url: this.#page.url(),
      }),
    );
  }

  async fill(refValue: string, value: string): Promise<BrowserPrimitiveObservation> {
    const input = FillInputSchema.parse({ ref: refValue, value });
    const locator = this.#interactive.get(input.ref);
    if (locator === undefined) throw new Error('browser_agent_unknown_interactive_ref');
    await locator.fill(input.value);
    return observation(
      'dom',
      `fill-${input.ref}`,
      FillResultSchema.parse({ ref: input.ref, filled: true }),
    );
  }

  async expectVisibleText(textValue: string): Promise<BrowserPrimitiveObservation> {
    const { text } = VisibleTextInputSchema.parse({ text: textValue });
    const matches = this.#page.getByText(text, { exact: true });
    await matches.first().waitFor({ state: 'visible', timeout: 5_000 });
    return observation(
      'dom',
      'visible-text',
      VisibleTextResultSchema.parse({ text, visible: true, matchCount: await matches.count() }),
    );
  }

  readConsole(): Promise<BrowserPrimitiveObservation> {
    EmptyInputSchema.parse({});
    return Promise.resolve(
      observation(
        'console',
        'console-entries',
        ConsoleResultSchema.parse({ entries: structuredClone(this.#consoleEntries) }),
      ),
    );
  }

  readFailedRequests(): Promise<BrowserPrimitiveObservation> {
    EmptyInputSchema.parse({});
    return Promise.resolve(
      observation(
        'network',
        'failed-requests',
        FailedRequestsResultSchema.parse({ requests: structuredClone(this.#failedRequests) }),
      ),
    );
  }

  async screenshot(labelValue: string): Promise<BrowserPrimitiveObservation> {
    const { label } = ScreenshotInputSchema.parse({ label: labelValue });
    const body = new Uint8Array(await this.#page.screenshot({ type: 'png' }));
    return observation('screenshot', label, ScreenshotResultSchema.parse({ label }), {
      contentType: 'image/png',
      body,
    });
  }
}
