export function codexHeartbeatQuiet(message: unknown): boolean {
  if (typeof message !== 'string') return false;
  let rest = message.trim();
  const take = (token: string) => {
    if (!rest.startsWith(token)) return false;
    rest = rest.slice(token.length).trimStart();
    return true;
  };
  const field = (name: string): string | null => {
    if (!take(`<${name}>`)) return null;
    const end = rest.indexOf(`</${name}>`);
    if (end < 0) return null;
    const value = rest.slice(0, end);
    if (value.includes('<')) return null;
    let decoded = value;
    for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;', '&apos;'])
      decoded = decoded.replaceAll(entity, '');
    if (decoded.includes('&')) return null;
    rest = rest.slice(end + name.length + 3).trimStart();
    return value.trim();
  };
  if (!take('<heartbeat>')) return false;
  const automation = field('automation_id');
  const decision = field('decision');
  const text = field('message');
  return (
    !!automation && decision === 'DONT_NOTIFY' && text !== null && take('</heartbeat>') && !rest
  );
}
