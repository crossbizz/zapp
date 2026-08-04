import { expect, type Page } from "@playwright/test";
import { Timeout } from "./test_helper";

function normalizeLineEndings(value: string | null) {
  return value?.replace(/\r\n?/g, "\n") ?? null;
}

// Shared helpers for driving the Monaco-based code editor from e2e tests.
// Extracted so specs that exercise editor interactions (editing, saving,
// committing) don't each re-implement the same window.monaco plumbing.

interface ActiveEditorState {
  path: string | null;
  content: string | null;
  hasTextFocus: boolean;
}

// Reads everything callers need off the editor the user is looking at. All three
// facts come from one page.evaluate so the "which editor?" answer — the one with
// text focus, else the first one with a model — is resolved once.
async function getActiveEditorState(
  page: Page,
): Promise<ActiveEditorState | null> {
  return page.evaluate(() => {
    // Monaco attaches itself to the window in the packaged app.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const monaco = (window as any).monaco;
    if (!monaco) {
      return null;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const editors = monaco.editor.getEditors() as any[];
    const editor =
      editors.find((candidate) => {
        return candidate.hasTextFocus?.() && candidate.getModel();
      }) ?? editors.find((candidate) => candidate.getModel());
    if (!editor) {
      return null;
    }

    return {
      path: editor.getModel()?.uri?.path ?? null,
      content: editor.getModel()?.getValue() ?? null,
      hasTextFocus: editor.hasTextFocus?.() ?? false,
    };
  });
}

export async function getActiveEditorModelPath(
  page: Page,
): Promise<string | null> {
  return (await getActiveEditorState(page))?.path ?? null;
}

export async function getActiveEditorModelContent(
  page: Page,
): Promise<string | null> {
  return (await getActiveEditorState(page))?.content ?? null;
}

export async function selectFileAndWaitForEditor(page: Page, fileName: string) {
  await page.getByText(fileName, { exact: true }).click();
  await expect(async () => {
    const modelPath = await getActiveEditorModelPath(page);
    expect(modelPath).toContain(fileName);
  }).toPass({ timeout: Timeout.MEDIUM });
}

export async function replaceEditorContent(page: Page, content: string) {
  // Click the rendered lines rather than focusing `.monaco-editor textarea`.
  // Monaco's NativeEditContext input path — what the bundled version uses — keeps
  // a `textarea.ime-text-area` around purely as an aria-hidden IME shim, so that
  // selector resolves to an element that swallows every keystroke while the real
  // input surface (`div.native-edit-context`) never gets focus. Clicking the
  // lines is what a user does, and it focuses whichever surface Monaco chose.
  const editorLines = page.locator(".monaco-editor .view-lines").first();
  await expect(editorLines).toBeVisible();
  await editorLines.click();
  // Gate on Monaco reporting text focus rather than sleeping: keys pressed before
  // the input surface is focused are dropped silently, and this turns that into a
  // focus failure instead of a puzzling content mismatch further down.
  await expect
    .poll(
      async () => (await getActiveEditorState(page))?.hasTextFocus ?? false,
      { timeout: Timeout.SHORT },
    )
    .toBe(true);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.insertText(content);
  await expect
    .poll(
      async () => normalizeLineEndings(await getActiveEditorModelContent(page)),
      { timeout: Timeout.MEDIUM },
    )
    .toEqual(normalizeLineEndings(content));
}
