export function runtimeWorkerUrl(source: string, compiled: string, moduleUrl: string): URL {
  const embedded = moduleUrl.includes('/$bunfs/root/') || moduleUrl.includes('/~BUN/root/');
  return new URL(embedded ? compiled : source, moduleUrl);
}
