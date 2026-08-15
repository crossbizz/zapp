const hiddenWorkspaceSegments = new Set([
  '.cache',
  '.git',
  '.next',
  '.turbo',
  '.vite',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'out',
]);

export function isVisibleWorkspacePath(path: string): boolean {
  const segments = path.replaceAll('\\', '/').split('/').filter(Boolean);
  return (
    !segments.some((segment) => hiddenWorkspaceSegments.has(segment)) &&
    !segments.some((segment) => segment.endsWith('.tsbuildinfo'))
  );
}
