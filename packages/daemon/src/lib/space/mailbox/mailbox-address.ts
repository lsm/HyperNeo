export type MailboxAddress =
  | { kind: 'session'; sessionId: string }
  | {
      kind: 'agent';
      spaceId: string;
      handle: string;
      taskId?: string;
      node?: string;
    };

type MailboxAgentAddress = Extract<MailboxAddress, { kind: 'agent' }>;

const SESSION_ADDRESS_KEYS = new Set(['kind', 'sessionId']);
const AGENT_ADDRESS_KEYS = new Set(['kind', 'spaceId', 'handle', 'taskId', 'node']);
const AGENT_QUERY_KEYS = new Set(['task', 'node']);

interface AgentQueryValues {
  task?: string;
  node?: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isWellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) return false;
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
    }
  }
  return true;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isWellFormed(value);
}

function decodeValue(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return isWellFormed(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function parseSessionAddress(rest: string): MailboxAddress | null {
  if (!rest || rest.includes('/') || rest.includes('?')) return null;
  const sessionId = decodeValue(rest);
  if (sessionId === null) return null;
  return { kind: 'session', sessionId };
}

function parseAgentQuery(query: string): AgentQueryValues | null {
  const values: AgentQueryValues = {};
  const seen = new Set<string>();
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) return null;
    const key = pair.slice(0, eq);
    if (!AGENT_QUERY_KEYS.has(key) || seen.has(key)) return null;
    const rawValue = pair.slice(eq + 1);
    if (!rawValue) return null;
    const value = decodeValue(rawValue);
    if (value === null) return null;
    seen.add(key);
    if (key === 'task') {
      values.task = value;
    } else {
      values.node = value;
    }
  }
  return values;
}

function parseAgentAddress(rest: string): MailboxAddress | null {
  const queryStart = rest.indexOf('?');
  const path = queryStart === -1 ? rest : rest.slice(0, queryStart);
  const query = queryStart === -1 ? null : rest.slice(queryStart + 1);
  const slash = path.indexOf('/');
  if (slash <= 0) return null;
  const rawSpaceId = path.slice(0, slash);
  const rawHandle = path.slice(slash + 1);
  if (!rawSpaceId || !rawHandle || rawHandle.includes('/')) return null;
  const spaceId = decodeValue(rawSpaceId);
  const handle = decodeValue(rawHandle);
  if (spaceId === null || handle === null) return null;
  if (handle.includes('/')) return null;
  let taskId: string | undefined;
  let node: string | undefined;
  if (query !== null) {
    if (!query) return null;
    const parsed = parseAgentQuery(query);
    if (parsed === null) return null;
    taskId = parsed.task;
    node = parsed.node;
  }
  const addr: MailboxAgentAddress = { kind: 'agent', spaceId, handle };
  if (taskId !== undefined) addr.taskId = taskId;
  if (node !== undefined) addr.node = node;
  return addr;
}

export function parseAddress(raw: string): MailboxAddress | null {
  if (typeof raw !== 'string') return null;
  if (raw.startsWith('session:')) return parseSessionAddress(raw.slice('session:'.length));
  if (raw.startsWith('agent:')) return parseAgentAddress(raw.slice('agent:'.length));
  return null;
}

export function renderAddress(addr: MailboxAddress): string {
  if (addr.kind === 'session') {
    return `session:${encodeURIComponent(addr.sessionId)}`;
  }
  let rendered = `agent:${encodeURIComponent(addr.spaceId)}/${encodeURIComponent(addr.handle)}`;
  const pairs: string[] = [];
  if (addr.taskId !== undefined) pairs.push(`task=${encodeURIComponent(addr.taskId)}`);
  if (addr.node !== undefined) pairs.push(`node=${encodeURIComponent(addr.node)}`);
  if (pairs.length > 0) rendered += `?${pairs.join('&')}`;
  return rendered;
}

export function isValidAddress(addr: MailboxAddress): boolean {
  if (!isPlainObject(addr)) return false;
  const keys = Object.keys(addr);
  if (addr.kind === 'session') {
    if (!keys.every((key) => SESSION_ADDRESS_KEYS.has(key))) return false;
    return isNonEmptyString(addr.sessionId);
  }
  if (addr.kind !== 'agent') return false;
  if (!keys.every((key) => AGENT_ADDRESS_KEYS.has(key))) return false;
  if (!isNonEmptyString(addr.spaceId) || !isNonEmptyString(addr.handle)) return false;
  if (addr.handle.includes('/')) return false;
  if (addr.taskId !== undefined && !isNonEmptyString(addr.taskId)) return false;
  if (addr.node !== undefined && !isNonEmptyString(addr.node)) return false;
  return true;
}
