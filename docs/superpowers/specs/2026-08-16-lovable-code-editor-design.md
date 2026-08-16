# Lovable-Parity Code Editor Design

**Date:** 2026-08-16
**Status:** Approved by the user's explicit request to clone the supplied Lovable code-editor reference without further questions.
**Owner:** WEB-21

## Goal

Replace the builder's plain file list and `<pre>` code display with a polished, Lovable-style workspace: a compact icon-led file tree, real open-file tabs, useful file actions, and syntax-colored CodeMirror code with line numbers.

## Reference

The live Lovable `codeEditor` view and the three supplied screenshots establish the visual and interaction contract:

- the file explorer is a narrow left rail with search, folder chevrons, recognizable file-type icons, compact rows, and a clear selected state;
- files open into tabs across the editor header and can be switched or closed independently;
- the selected tab exposes reference, copy, and download actions on the right;
- the editor uses a real code-editor surface with line numbers, syntax coloring, active-line feedback, selection, and full-height scrolling;
- borders, spacing, typography, and controls stay quiet so source code remains the dominant visual element.

The result mirrors that interaction model and density with zapp.build tokens and copy. It does not copy Lovable source, proprietary assets, upgrade gating, or branding.

## Approaches considered

### 1. CodeMirror 6 — selected

Use the stack already bound by Plan 08. A small React adapter owns the CodeMirror `EditorView`, reconfigures language and read-only state, and emits edits only while the existing Owner/Builder edit mode is active. This provides a real editor with a smaller web footprint than Monaco and preserves the current public workspace APIs.

### 2. Monaco Editor

Monaco would closely resemble VS Code and already exists in the desktop dependency graph, but adding it to the browser bundle would be heavier and would contradict Plan 08's CodeMirror decision. It is not selected.

### 3. Static Shiki or Prism rendering

A static highlighter would make the code colorful but would not be a real editor, would not preserve the existing direct-edit flow, and would fall short of the user's explicit requirement. It is not selected.

## Architecture

`CodeView` remains the owner of tenant-scoped workspace loading, file reads, direct-edit saves, and commit comparison. It gains an in-memory ordered tab model keyed by canonical workspace path. Opening a file selects an existing tab or appends one; closing the selected tab activates the nearest surviving tab. Each tab retains its fetched file record, current text, saved text, and compare token.

`FileTree` remains lazy and API-backed. It adds semantic tree roles, expand/collapse-all control, active-path state, file-type icons, compact hierarchy guides, and search behavior that exposes matching descendants without issuing speculative reads.

`CodeEditor` is a focused client component. It creates one CodeMirror 6 view, maps the path extension to TypeScript/JavaScript, CSS, HTML, JSON, Markdown, or plain text support, and uses compartments to reconfigure language and editability without recreating the editor. It never calls an API.

`CodeView` adds toolbar actions for the active file:

- **Copy file reference** copies an `@path` token and reports the action truthfully in the live status region; no hidden model or provider call is added.
- **Copy file content** uses the browser clipboard and reports success or failure.
- **Download file** creates a local Blob download with the file's basename and revokes the object URL.

The existing Owner/Builder `Edit file` action remains available. Edit mode enables CodeMirror; Save uses the existing public keyed direct-edit API and updates the selected tab's compare token. Cancel restores the saved text. Tabs with unsaved changes show a dot and cannot be closed until saved or cancelled.

## Visual contract

- Explorer width: `14rem` at normal desktop widths, with a `12rem` compact fallback.
- Editor and explorer fill the available workspace height with independent scrolling.
- Tabs are 2.5rem high, path-labelled, horizontally scrollable, and use a blue bottom/outline accent only for selection.
- Toolbar controls are icon buttons with accessible names and tooltips; Download may include a visible label when space permits.
- Code uses Geist Mono, 13px–14px text, 1.55 line height, a neutral gutter, subtle active-line fill, and CodeMirror syntax colors tuned to the light zapp.build canvas.
- The current Preview/Files/Code/More tab model and builder split-pane behavior stay unchanged.

## State and error handling

- Organization, project, branch, or surface changes abort pending reads and reset workspace, entries, tabs, editor state, and status together.
- Stale file reads cannot populate a new organization or workspace generation.
- A failed open leaves existing tabs intact and announces `The file could not be opened.`
- Clipboard and download failures never claim success.
- Saving preserves unsaved text on failure and announces the existing conflict/retry message.
- Binary or undecodable text continues through the existing workspace boundary response; this task does not add source-content heuristics or a private API.

## Accessibility

- The explorer uses `tree`/`treeitem`, folder rows expose `aria-expanded`, and selected files expose `aria-selected`.
- The tab strip uses `tablist`/`tab`, supports ArrowLeft/ArrowRight/Home/End, and close buttons have path-specific labels.
- CodeMirror is focusable and labelled `Code editor for <path>` in both read-only and editable modes.
- All toolbar actions have accessible names and visible focus rings.
- Status changes use the existing polite live region; color is never the only selected/dirty signal.

## Testing

Playwright will prove the user-visible contract against fixture workspace APIs:

1. Code opens as a full-height editor with line numbers and syntax-highlighted tokens.
2. Tree rows expose folder/file icons, search, expand-all, selection, and keyboard-operable folder state.
3. Opening two files creates two tabs without duplicates; switching and closing tabs selects the correct file.
4. Content-copy, reference-copy, and download actions operate on the selected file; reference copy emits the exact `@path` token.
5. Owners/Builders can edit, cancel, and save through the existing API; Viewer remains read-only.
6. Existing builder layout, Preview/Files/Code/More keyboard navigation, and commit comparison behavior remain green.

Web lint, typecheck, production build, the full builder browser suite, and the repository verification gate complete the acceptance run.

## Scope boundaries

- No backend route, schema, generated SDK, provider, or workspace contract changes.
- No collaborative cursors, minimap, terminal, command palette, multi-file search, or language server.
- No Lovable branding, upgrade copy, proprietary assets, or source-code reuse.
