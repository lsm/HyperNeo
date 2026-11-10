export function workspaceLabel(path: string | null): string {
  if (!path) return 'No folder';
  return path.split('/').filter(Boolean).at(-1) ?? path;
}
