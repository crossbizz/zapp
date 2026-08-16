export type EditorLanguage = 'css' | 'html' | 'javascript' | 'json' | 'markdown' | 'text';

export function editorLanguageForPath(path: string): EditorLanguage {
  const extension = path.split('.').at(-1)?.toLocaleLowerCase('en-US');
  if (['cjs', 'js', 'jsx', 'mjs', 'ts', 'tsx'].includes(extension ?? '')) {
    return 'javascript';
  }
  if (extension === 'css') return 'css';
  if (extension === 'htm' || extension === 'html') return 'html';
  if (extension === 'json' || extension === 'jsonc') return 'json';
  if (extension === 'md' || extension === 'mdx') return 'markdown';
  return 'text';
}
