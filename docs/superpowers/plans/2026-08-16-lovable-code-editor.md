# Lovable-Parity Code Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing zapp.build code surface into a polished Lovable-style file explorer and tabbed, syntax-colored CodeMirror 6 editor without changing workspace APIs.

**Architecture:** `CodeView` continues to own tenant-scoped API and save state, `FileTree` owns lazy hierarchy/search, and a new `CodeEditor` component owns the CodeMirror lifecycle. An ordered in-memory tab model connects the tree, editor header, toolbar actions, and existing direct-edit flow.

**Tech Stack:** Next.js 15, React 19, TypeScript 5.6, CodeMirror 6, Playwright, Node test runner.

## Global Constraints

- Keep all source reads and edits on the existing generated public `/v1` SDK methods.
- Do not add a backend route, schema, provider call, private UI endpoint, or source-content heuristic.
- Preserve Owner/Builder edit access and Viewer read-only access.
- Reset and fence tabs, source text, file selection, and requests on organization/project/branch changes.
- Use zapp.build tokens, branding, and copy; do not copy Lovable source or proprietary assets.
- Preserve unrelated working-tree changes.

---

### Task 1: WEB-21 Lovable-parity tabbed code editor

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/src/components/code/editor-language.ts`
- Create: `apps/web/src/components/code/CodeEditor.tsx`
- Modify: `apps/web/src/components/code/FileTree.tsx`
- Modify: `apps/web/src/components/code/CodeView.tsx`
- Modify: `apps/web/src/components/code/code.module.css`
- Create: `apps/web/test/code-editor.test.ts`
- Modify: `apps/web/e2e/builder-shell.spec.ts`
- Modify: `docs/plans/08-web-ux.md`
- Modify: `tasks/todo.md`

**Interfaces:**
- Produces: `editorLanguageForPath(path): 'css' | 'html' | 'javascript' | 'json' | 'markdown' | 'text'`.
- Produces: `CodeEditor({ editable, onChange, path, value })` using CodeMirror compartments for language and editability.
- Extends: `FileTree` with `activePath`, `onCollapseAll`, `onExpandAll`, and semantic selected tree state while preserving `onOpen` and `onOpenDirectory`.
- Preserves: `CodeView` props and every existing control-plane client call.

- [ ] **Step 1: Write failing language and browser tests**

Add `apps/web/test/code-editor.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { editorLanguageForPath } from '../src/components/code/editor-language';

test('maps common workspace paths to CodeMirror languages', () => {
  assert.equal(editorLanguageForPath('src/App.tsx'), 'javascript');
  assert.equal(editorLanguageForPath('src/styles.css'), 'css');
  assert.equal(editorLanguageForPath('index.html'), 'html');
  assert.equal(editorLanguageForPath('package.json'), 'json');
  assert.equal(editorLanguageForPath('README.md'), 'markdown');
  assert.equal(editorLanguageForPath('public/favicon.ico'), 'text');
});
```

Add a focused Playwright case to `apps/web/e2e/builder-shell.spec.ts` that routes one active workspace, a lazy `src` directory, two source files, and two file reads, then proves:

```ts
test('renders a Lovable-style tabbed CodeMirror workspace with file actions', async ({ page }) => {
  await mockCodeWorkspace(page);
  await openBuilder(page);
  await page.getByRole('tab', { name: 'Code' }).click();

  await expect(page.getByRole('tree', { name: 'Workspace files' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand all folders' }).click();
  await page.getByRole('button', { name: 'src/App.tsx' }).click();
  await expect(page.getByRole('tab', { name: 'src/App.tsx' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByLabel('Code editor for src/App.tsx').locator('.cm-lineNumbers')).toBeVisible();
  expect(await page.getByLabel('Code editor for src/App.tsx').locator('.cm-line span').count()).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'src/styles.css' }).click();
  await expect(page.getByRole('tablist', { name: 'Open file tabs' }).getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: 'Copy file reference' }).click();
  await expect(page.getByRole('status')).toContainText('Copied @src/styles.css');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download file' }).click();
  expect((await download).suggestedFilename()).toBe('styles.css');
});
```

The helper must also assert the exact organization header on workspace file list/read calls and expose both Viewer read-only and Owner/Builder editable fixtures.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @zapp/web exec tsx --test test/code-editor.test.ts
pnpm --filter @zapp/web exec playwright test e2e/builder-shell.spec.ts --grep "Lovable-style tabbed CodeMirror"
```

Expected: the unit test cannot import `editor-language.ts`, and the browser test cannot find the tree semantics, file tabs, CodeMirror gutters, or toolbar actions.

- [ ] **Step 3: Add CodeMirror 6 dependencies and the language adapter**

Run:

```bash
pnpm --filter @zapp/web add codemirror@6.0.2 @codemirror/state@6.7.1 @codemirror/view@6.43.8 @codemirror/lang-javascript@6.2.5 @codemirror/lang-css@6.3.1 @codemirror/lang-html@6.4.12 @codemirror/lang-json@6.0.2 @codemirror/lang-markdown@6.5.2
```

If the registry resolves newer compatible patch/minor releases under the exact major lines, retain the lockfile resolution and record it in the execution log.

Implement the path mapper with case-insensitive extensions:

```ts
export type EditorLanguage = 'css' | 'html' | 'javascript' | 'json' | 'markdown' | 'text';

export function editorLanguageForPath(path: string): EditorLanguage {
  const extension = path.split('.').at(-1)?.toLowerCase();
  if (['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx'].includes(extension ?? '')) return 'javascript';
  if (extension === 'css') return 'css';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'json' || extension === 'jsonc') return 'json';
  if (extension === 'md' || extension === 'mdx') return 'markdown';
  return 'text';
}
```

Also append `test/code-editor.test.ts` to the web package's Node test command.

- [ ] **Step 4: Run the language test and verify GREEN**

Run: `pnpm --filter @zapp/web exec tsx --test test/code-editor.test.ts`

Expected: `1` test passes.

- [ ] **Step 5: Implement the CodeMirror adapter**

Create `CodeEditor.tsx` with this public surface:

```ts
export interface CodeEditorProps {
  readonly editable: boolean;
  readonly onChange: (value: string) => void;
  readonly path: string;
  readonly value: string;
}
```

Instantiate one `EditorView`; use `Compartment` instances for language and read-only configuration; dispatch external value changes only when `view.state.doc.toString() !== value`; destroy the view on unmount. Apply `basicSetup`, line wrapping, labelled content attributes, a full-height theme, and light syntax colors. `EditorState.readOnly` and `EditorView.editable` must both follow `editable`.

- [ ] **Step 6: Implement the semantic file tree and tabbed editor shell**

In `FileTree`:

- render the search and expand/collapse-all controls in one sticky explorer header;
- render `role="tree"` and `role="treeitem"`, `aria-expanded` for directories, and `aria-selected` for the active file;
- use inline, zapp-owned SVG icons for folders and common file types;
- preserve lazy directory reads and sorted folders-first traversal.

In `CodeView`, replace the single `file/content` pair with:

```ts
interface OpenFileTab {
  readonly file: WorkspaceFileData;
  readonly savedContent: string;
  readonly content: string;
}
```

Opening a file must deduplicate by path; clicking a tab activates it; closing selects the nearest sibling; a dirty tab renders an accessible `Unsaved` label and refuses close until Save or Cancel. Add icon buttons for Copy file reference, Copy file content, and Download file. Keep direct-edit saves and commit comparison intact.

- [ ] **Step 7: Style to the reference and verify browser GREEN**

Update `code.module.css` for the 14rem explorer, hierarchy guides, compact icon rows, selected file treatment, horizontal tab strip, icon toolbar, full-height CodeMirror scroller, light gutter, active line, focus rings, and 12rem compact breakpoint.

Run:

```bash
pnpm --filter @zapp/web exec playwright test e2e/builder-shell.spec.ts --grep "Lovable-style tabbed CodeMirror"
```

Expected: the new browser case passes.

- [ ] **Step 8: Run focused and package gates**

Run:

```bash
pnpm --filter @zapp/web exec playwright test e2e/builder-shell.spec.ts
pnpm --filter @zapp/web lint
pnpm --filter @zapp/web typecheck
pnpm --filter @zapp/web build
git diff --check
```

Expected: the full builder-shell suite, lint, typecheck, production build, and whitespace checks pass.

- [ ] **Step 9: Compare visually in the local browser**

Reload the existing local `?view=code` tab, open at least two files, and compare it with the retained Lovable reference at the same desktop viewport. Verify tree density, icons, tabs, toolbar alignment, syntax colors, line-number gutter, scrolling, focus rings, and no overflow regression. Fix visual defects and rerun Step 8.

- [ ] **Step 10: Run repository verification, record, and commit**

Run: `pnpm verify`

Check WEB-21 in `tasks/todo.md`, mark every task bullet in `docs/plans/08-web-ux.md`, append one execution-log line including skips/deviations, and commit:

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/components/code apps/web/test/code-editor.test.ts apps/web/e2e/builder-shell.spec.ts docs/plans/08-web-ux.md docs/superpowers/plans/2026-08-16-lovable-code-editor.md tasks/todo.md
git commit -m "feat(web): add Lovable-parity code editor"
```
