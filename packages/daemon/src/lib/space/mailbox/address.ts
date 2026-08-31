export type MailboxAddress =
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'agent';
      spaceId: string;
      handle: string;
      taskId?: string;
      node?: string;
    };

const AGENT_FIELD_KEYS = new Set(['kind', 'spaceId', 'handle', 'taskId', 'node']);

function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function parseAgentQuery(query: string): { taskId?: string; node?: string } | null {
  const parsed: { taskId?: string; node?: string } = {};
  for (const pair of query.split('&')) {
    if (pair.length === 0) return null;
    const separator = pair.indexOf('=');
    if (separator === -1) return null;
    const key = pair.slice(0, separator);
    if (key !== 'task' && key !== 'node') return null;
    const field = key === 'task' ? 'taskId' : 'node';
    if (parsed[field] !== undefined) return null;
    const value = decodeSegment(pair.slice(separator + 1));
    if (value === null || value.length === 0) return null;
    parsed[field] = value;
  }
  return parsed;
}

export function parseAddress(raw: string): MailboxAddress | null {
  if (raw.length === 0) return null;
  const queryStart = raw.indexOf('?');
  const path = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const query = queryStart === -1 ? null : raw.slice(queryStart + 1);
  const schemeSeparator = path.indexOf(':');
  if (schemeSeparator === -1) return null;
  const scheme = path.slice(0, schemeSeparator);
  const rest = path.slice(schemeSeparator + 1);
  if (scheme === 'session') {
    if (query !== null || rest.length === 0 || rest.includes('/')) return null;
    const sessionId = decodeSegment(rest);
    if (sessionId === null || sessionId.length === 0) return null;
    const address: MailboxAddress = { kind: 'session', sessionId };
    return isValidAddress(address) ? address : null;
  }
  if (scheme === 'agent') {
    const handleSeparator = rest.indexOf('/');
    if (handleSeparator === -1) return null;
    const spaceId = decodeSegment(rest.slice(0, handleSeparator));
    const handle = decodeSegment(rest.slice(handleSeparator + 1));
    if (spaceId === null || spaceId.length === 0) return null;
    if (handle === null || handle.length === 0 || handle.includes('/')) return null;
    const extras = query === null ? {} : parseAgentQuery(query);
    if (extras === null) return null;
    const address: MailboxAddress = { kind: 'agent', spaceId, handle, ...extras };
    return isValidAddress(address) ? address : null;
  }
  return null;
}

export function renderAddress(addr: MailboxAddress): string {
  if (addr.kind === 'session') {
    return `session:${encodeURIComponent(addr.sessionId)}`;
  }
  const params: string[] = [];
  if (addr.taskId !== undefined) params.push(`task=${encodeURIComponent(addr.taskId)}`);
  if (addr.node !== undefined) params.push(`node=${encodeURIComponent(addr.node)}`);
  const suffix = params.length === 0 ? '' : `?${params.join('&')}`;
  return `agent:${encodeURIComponent(addr.spaceId)}/${encodeURIComponent(addr.handle)}${suffix}`;
}

export function isValidAddress(addr: MailboxAddress): boolean {
  if (!isPlainObject(addr)) return false;
  const record = addr as Record<string, unknown>;
  const keys = Object.keys(record);
  if (addr.kind === 'session') {
    if (keys.length !== 2 || !keys.includes('kind') || !keys.includes('sessionId')) return false;
    return isNonEmptyString(record.sessionId);
  }
  if (addr.kind === 'agent') {
    for (const key of keys) {
      if (!AGENT_FIELD_KEYS.has(key)) return false;
    }
    if (!keys.includes('kind') || !keys.includes('spaceId') || !keys.includes('handle')) {
      return false;
    }
    if (!isNonEmptyString(record.spaceId)) return false;
    if (!isNonEmptyString(record.handle) || record.handle.includes('/')) return false;
    if (keys.includes('taskId') && !isNonEmptyString(record.taskId)) return false;
    if (keys.includes('node') && !isNonEmptyString(record.node)) return false;
    return true;
  }
  return false;
}
