export function resolveNeoEntry(url: URL) {
  if (url.pathname === '/neo/' || url.pathname === '/neo/index.html') {
    return { kind: 'redirect' as const, location: `/neo${url.search}${url.hash}` };
  }
  if (url.pathname === '/neo') {
    return { kind: 'entry' as const, path: '/neo/index.html' };
  }
  return null;
}
