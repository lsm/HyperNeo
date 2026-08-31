export type MailboxAddress =
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'agent';
      spaceId: string;
      handle: string;
      taskId?: string;
      node?: string;
    };

const SESSION_PREFIX = 'session:';
const AGENT_PREFIX = 'agent:';

function safeDecode(input: string): string | null {
  try {
    return decodeURIComponent(input);
  } catch {
    return null;
  }
}

export function parseAddress(raw: string): MailboxAddress | null {
  if (raw.startsWith(SESSION_PREFIX)) {
    const sessionId = raw.slice(SESSION_PREFIX.length);
    if (!sessionId) return null;
    return { kind: 'session', sessionId };
  }

  if (raw.startsWith(AGENT_PREFIX)) {
    const rest = raw.slice(AGENT_PREFIX.length);
    if (!rest) return null;

    const qMark = rest.indexOf('?');
    const pathPart = qMark >= 0 ? rest.slice(0, qMark) : rest;
    const queryPart = qMark >= 0 ? rest.slice(qMark + 1) : '';

    const slash = pathPart.indexOf('/');
    if (slash < 0) return null;

    const rawHandle = pathPart.slice(slash + 1);

    if (rawHandle.includes('/')) return null;

    const spaceId = safeDecode(pathPart.slice(0, slash));
    if (!spaceId) return null;
    const handle = safeDecode(rawHandle);
    if (!handle) return null;

    let taskId: string | undefined;
    let node: string | undefined;

    if (queryPart.length > 0) {
      const pairs = queryPart.split('&');
      for (const pair of pairs) {
        const eq = pair.indexOf('=');
        if (eq < 0) return null;
        const key = safeDecode(pair.slice(0, eq));
        if (!key) return null;
        const value = safeDecode(pair.slice(eq + 1));
        if (value === null) return null;

        switch (key) {
          case 'task':
            taskId = value;
            break;
          case 'node':
            node = value;
            break;
          default:
            return null;
        }
      }
    }

    const addr: MailboxAddress = { kind: 'agent', spaceId, handle };
    if (taskId !== undefined) addr.taskId = taskId;
    if (node !== undefined) addr.node = node;
    return addr;
  }

  return null;
}

export function renderAddress(addr: MailboxAddress): string {
  if (addr.kind === 'session') {
    return `${SESSION_PREFIX}${addr.sessionId}`;
  }

  let base = `${AGENT_PREFIX}${encodeURIComponent(addr.spaceId)}/${encodeURIComponent(addr.handle)}`;

  const parts: string[] = [];
  if (addr.taskId !== undefined) {
    parts.push(`task=${encodeURIComponent(addr.taskId)}`);
  }
  if (typeof addr.node === 'string') {
    parts.push(`node=${encodeURIComponent(addr.node)}`);
  }
  if (parts.length > 0) base += `?${parts.join('&')}`;

  return base;
}

export function isValidAddress(addr: MailboxAddress): boolean {
  if (Object.prototype.toString.call(addr) !== '[object Object]') return false;

  const kind = 'kind' in addr ? (addr.kind as string) : undefined;
  if (kind !== 'session' && kind !== 'agent') return false;

  if (kind === 'session') {
    const sessionId = 'sessionId' in addr ? (addr.sessionId as string) : undefined;
    if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
    if ('spaceId' in addr) return false;
    if ('handle' in addr) return false;
    if ('taskId' in addr) return false;
    if ('node' in addr) return false;
    return true;
  }

  const spaceId = 'spaceId' in addr ? (addr.spaceId as string) : undefined;
  const handle = 'handle' in addr ? (addr.handle as string) : undefined;

  if (typeof spaceId !== 'string' || spaceId.length === 0) return false;
  if (typeof handle !== 'string' || handle.length === 0) return false;
  if (handle.includes('/')) return false;

  if ('taskId' in addr) {
    const taskId = addr.taskId as string | undefined;
    if (typeof taskId !== 'string' || taskId.length === 0) return false;
  }

  if ('node' in addr) {
    const node = addr.node as string | undefined;
    if (typeof node !== 'string' || node.length === 0) return false;
  }

  return true;
}
