import { win32 } from 'node:path';

export function runtimeWorkerUrl(
  source: string,
  compiled: string,
  moduleUrl: string
): string | URL {
  const windowsModule = moduleUrl.replaceAll('\\', '/').replace(/^file:\/\/\//, '');
  if (/^[A-Za-z]:\/~BUN\/root\//.test(windowsModule)) {
    return win32.resolve(win32.dirname(windowsModule), compiled);
  }
  const embedded = moduleUrl.includes('/$bunfs/root/');
  return new URL(embedded ? compiled : source, moduleUrl);
}
