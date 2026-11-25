import { fileURLToPath } from 'node:url';

export function cursorWorkspaceFolder(
  path: string,
  marshalled: boolean,
  windows = process.platform === 'win32'
): string | null {
  if (!path.startsWith('/')) return null;
  try {
    const escaped = path.split('/').map(encodeURIComponent).join('/');
    const pathname = marshalled ? escaped : escaped.replace(/%25([\da-f]{2})/gi, '%$1');
    return fileURLToPath(`file://${pathname}`, { windows });
  } catch {
    return null;
  }
}
