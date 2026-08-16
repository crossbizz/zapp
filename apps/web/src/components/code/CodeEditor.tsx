'use client';

import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef, type ReactElement } from 'react';

import styles from './code.module.css';
import { editorLanguageForPath } from './editor-language';

export interface CodeEditorProps {
  readonly path: string;
  readonly value: string;
}

function languageForPath(path: string): Extension {
  switch (editorLanguageForPath(path)) {
    case 'css':
      return css();
    case 'html':
      return html();
    case 'javascript': {
      const extension = path.split('.').at(-1)?.toLocaleLowerCase('en-US');
      return javascript({
        jsx: extension === 'jsx' || extension === 'tsx',
        typescript: extension === 'ts' || extension === 'tsx',
      });
    }
    case 'json':
      return json();
    case 'markdown':
      return markdown();
    case 'text':
      return [];
  }
}

function dynamicConfiguration(path: string): Extension {
  return [
    languageForPath(path),
    EditorView.contentAttributes.of({
      'aria-label': `Read-only source for ${path}`,
      'aria-readonly': 'true',
      'data-language': editorLanguageForPath(path),
    }),
  ];
}

const viewerTheme = EditorView.theme({
  '&': {
    backgroundColor: '#ffffff',
    color: '#20242c',
    fontSize: '14px',
    height: '100%',
  },
  '.cm-activeLine': { backgroundColor: '#f1f5ff' },
  '.cm-activeLineGutter': { backgroundColor: '#f1f5ff', color: '#4b5563' },
  '.cm-content': {
    caretColor: 'transparent',
    fontFamily: '"Roboto Mono Variable", monospace',
    fontSize: '14px',
    lineHeight: '19.6px',
    padding: '0 0 3rem',
  },
  '.cm-gutters': {
    backgroundColor: '#fbfcfe',
    borderRight: '1px solid #edf0f4',
    color: '#87909d',
  },
  '.cm-line': { padding: '0 2px 0 6px' },
  '.cm-scroller': { fontFamily: 'inherit', overflow: 'auto' },
  '&.cm-focused': { outline: 'none' },
});

export function CodeEditor({ path, value }: CodeEditorProps): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<EditorView | undefined>(undefined);
  const configurationRef = useRef({ path, value });
  const languageCompartmentRef = useRef(new Compartment());
  configurationRef.current = { path, value };

  useEffect(() => {
    const parent = containerRef.current;
    if (parent === null) return undefined;
    const initial = configurationRef.current;
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial.value,
        extensions: [
          basicSetup,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          viewerTheme,
          languageCompartmentRef.current.of(dynamicConfiguration(initial.path)),
        ],
      }),
    });
    editorRef.current = view;
    return () => {
      view.destroy();
      editorRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const view = editorRef.current;
    if (view === undefined) return;
    const currentValue = view.state.doc.toString();
    view.dispatch({
      ...(currentValue === value
        ? {}
        : { changes: { from: 0, insert: value, to: currentValue.length } }),
      effects: languageCompartmentRef.current.reconfigure(dynamicConfiguration(path)),
    });
  }, [path, value]);

  return (
    <div
      aria-label={`Code editor for ${path}`}
      className={styles.codeEditor}
      ref={containerRef}
      role="region"
    />
  );
}
