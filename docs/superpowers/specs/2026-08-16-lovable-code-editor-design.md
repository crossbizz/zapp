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

Use the same editor family verified in Lovable's live rendered DOM: CodeMirror 6 (`cm-editor`, `cm-content`, and its read-only textbox contract). A small React adapter owns a permanently read-only `EditorView` and reconfigures its language when tabs change. This provides the requested real viewer with a smaller web footprint than Monaco and preserves the current public workspace APIs.

### 2. Monaco Editor

Monaco would closely resemble VS Code and already exists in the desktop dependency graph, but adding it to the browser bundle would be heavier and would contradict Plan 08's CodeMirror decision. It is not selected.

### 3. Static Shiki or Prism rendering

A static highlighter would make the code colorful but would not provide the real editor viewer demonstrated by the reference. It is not selected.

## Architecture

`CodeView` remains the owner of tenant-scoped workspace loading, file reads, and commit comparison. It gains an in-memory ordered tab model keyed by canonical workspace path. Opening a file selects an existing tab or appends one; closing the selected tab activates the nearest surviving tab. Each tab retains its fetched file record and decoded text.

`FileTree` remains lazy and API-backed. It adds semantic tree roles, expand/collapse-all control, active-path state, disclosure-only directory rows, file-type icons, compact hierarchy guides, and search behavior that exposes matching descendants without issuing speculative reads.

`CodeEditor` is a focused client component. It creates one read-only CodeMirror 6 view, maps the path extension to TypeScript/JavaScript, CSS, HTML, JSON, Markdown, or plain text support, and uses a compartment to reconfigure language without recreating the editor. It never calls an API.

`CodeView` adds toolbar actions for the active file:

- **Reference file in chat** adds a removable `@path` chip to the project composer. The next submitted message serializes the referenced workspace path as structured context, so the agent can read the current branch copy through its existing workspace tools.
- **Copy file content** uses the browser clipboard and reports success or failure.
- **Download file** creates a local Blob download with the file's basename and revokes the object URL.

Per the user's product clarification, the code surface is viewer-only for every role. WEB-21 removes edit/save controls from this surface; code changes continue through chat-driven runs rather than direct browser editing.

## Visual contract

- Explorer width: `15rem` at normal desktop widths, with a `14rem` compact fallback, matching the live reference's measured 239px rail.
- Editor and explorer fill the available workspace height with independent scrolling.
- Tabs are 2.5rem high, path-labelled, horizontally scrollable, and use a blue bottom/outline accent only for selection.
- Toolbar controls are icon buttons with accessible names and tooltips; Download may include a visible label when space permits.
- Code bundles the same Roboto Mono Variable family measured in Lovable, at the same 14px size and 19.6px line height, with a neutral 12px gutter, subtle active-line fill, and CodeMirror syntax colors tuned to the light zapp.build canvas.
- Explorer labels use the measured 14px regular sans treatment in dense 28px rows; directories use Lovable's single chevron rather than adding a second folder glyph.
- The current Preview/Files/Code/More tab model and builder split-pane behavior stay unchanged.

## State and error handling

- Organization, project, branch, or surface changes abort pending reads and reset workspace, entries, tabs, editor state, and status together.
- Stale file reads cannot populate a new organization or workspace generation.
- A failed open leaves existing tabs intact and announces `The file could not be opened.`
- Clipboard, reference, and download failures never claim success.
- Binary or undecodable text continues through the existing workspace boundary response; this task does not add source-content heuristics or a private API.

## Accessibility

- The explorer uses `tree`/`treeitem`, folder rows expose `aria-expanded`, and selected files expose `aria-selected`.
- The tab strip uses `tablist`/`tab`, supports ArrowLeft/ArrowRight/Home/End, and close buttons have path-specific labels.
- CodeMirror is focusable, labelled `Code editor for <path>`, and exposes `aria-readonly="true"` for every role.
- All toolbar actions have accessible names and visible focus rings.
- Status changes use the existing polite live region; color is never the only selected/dirty signal.

## Testing

Playwright will prove the user-visible contract against fixture workspace APIs:

1. Code opens as a full-height editor with line numbers and syntax-highlighted tokens.
2. Tree rows expose folder/file icons, search, expand-all, selection, and keyboard-operable folder state.
3. Opening two files creates two tabs without duplicates; switching and closing tabs selects the correct file.
4. Content-copy, chat-reference, and download actions operate on the selected file; chat reference creates a removable `@path` composer chip and is included in the next message context.
5. Owner, Builder, and Viewer sessions all receive a read-only CodeMirror surface.
6. Existing builder layout, Preview/Files/Code/More keyboard navigation, and commit comparison behavior remain green.

Web lint, typecheck, production build, the full builder browser suite, and the repository verification gate complete the acceptance run.

## Scope boundaries

- No backend route, schema, generated SDK, provider, or workspace contract changes.
- No collaborative cursors, minimap, terminal, command palette, multi-file search, or language server.
- No Lovable branding, upgrade copy, proprietary assets, or source-code reuse.
