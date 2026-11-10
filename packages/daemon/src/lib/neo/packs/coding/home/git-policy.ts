export const publicationLog = [
  'log',
  '--format=raw',
  '-m',
  '-p',
  '-a',
  '--no-ext-diff',
  '--no-textconv',
];

export function homeRemoteUrl(remote: string): string | null {
  try {
    const scp = remote.match(/^[^@/]+@([^:]+):(.+)$/);
    let url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote);
    if (url.protocol === 'ssh:') url = new URL(`https://${url.hostname}${url.pathname}`);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\.git\/?$/, '');
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}
