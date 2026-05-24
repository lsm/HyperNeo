export type HandleAddress = {
  kind: 'handle';
  handle: string;
};

export type RoleAddress = {
  kind: 'role';
  role: string;
};

export type SessionAddress = {
  kind: 'session';
  sessionId: string;
};

export type WorkerAddress = {
  kind: 'worker';
  workflowRunId?: string;
  nodeId: string;
  agentName?: string;
};

export type ChannelAddress = {
  kind: 'channel';
  name: string;
};

export type ParsedAddress =
  | HandleAddress
  | RoleAddress
  | SessionAddress
  | WorkerAddress
  | ChannelAddress;

const WORKER_PREFIX = '@worker:';
const ROLE_PREFIX = '@role:';
const SESSION_PREFIX = '@session:';

export function parseAddress(target: string): ParsedAddress {
  if (target.length === 0) {
    throw new Error('Address cannot be empty');
  }

  if (target.startsWith('#')) {
    const name = target.slice(1);
    assertSegment(name, 'channel name');
    if (name.startsWith('#')) {
      throw new Error(`Channel address cannot contain extra # prefix: ${target}`);
    }
    return { kind: 'channel', name };
  }

  if (!target.startsWith('@')) {
    throw new Error(`Address must start with @ or #: ${target}`);
  }

  if (target.startsWith(ROLE_PREFIX)) {
    const role = target.slice(ROLE_PREFIX.length);
    assertSegment(role, 'role');
    return { kind: 'role', role };
  }

  if (target.startsWith(SESSION_PREFIX)) {
    const sessionId = target.slice(SESSION_PREFIX.length);
    assertSegment(sessionId, 'session id');
    return { kind: 'session', sessionId };
  }

  if (target.startsWith(WORKER_PREFIX)) {
    return parseWorkerAddress(target.slice(WORKER_PREFIX.length), target);
  }

  const handle = target.slice(1);
  assertSegment(handle, 'handle');
  if (handle.includes('@') || handle.includes(':') || handle.includes('/')) {
    throw new Error(`Handle address cannot contain '@', ':', or '/': ${target}`);
  }
  return { kind: 'handle', handle };
}

export function formatAddress(address: ParsedAddress): string {
  switch (address.kind) {
    case 'handle':
      assertSegment(address.handle, 'handle');
      if (
        address.handle.includes('@') ||
        address.handle.includes(':') ||
        address.handle.includes('/')
      ) {
        throw new Error(`Handle address cannot contain '@', ':', or '/': @${address.handle}`);
      }
      return `@${address.handle}`;
    case 'role':
      assertSegment(address.role, 'role');
      return `${ROLE_PREFIX}${address.role}`;
    case 'session':
      assertSegment(address.sessionId, 'session id');
      return `${SESSION_PREFIX}${address.sessionId}`;
    case 'worker':
      return formatWorkerAddress(address);
    case 'channel':
      assertSegment(address.name, 'channel name');
      if (address.name.startsWith('#')) {
        throw new Error(`Channel address cannot contain extra # prefix: #${address.name}`);
      }
      return `#${address.name}`;
  }
}

export function isAddress(target: string): boolean {
  try {
    parseAddress(target);
    return true;
  } catch {
    return false;
  }
}

function parseWorkerAddress(value: string, rawTarget: string): WorkerAddress {
  const parts = value.split('/');
  if (parts.length !== 1 && parts.length !== 2 && parts.length !== 3) {
    throw new Error(
      `Worker address must use @worker:<node>, @worker:<node>/<agent>, or @worker:<run>/<node>/<agent>: ${rawTarget}`
    );
  }

  for (const part of parts) {
    assertSegment(part, 'worker segment');
  }

  if (parts.length === 1) {
    return { kind: 'worker', nodeId: parts[0] };
  }

  if (parts.length === 2) {
    return { kind: 'worker', nodeId: parts[0], agentName: parts[1] };
  }

  return { kind: 'worker', workflowRunId: parts[0], nodeId: parts[1], agentName: parts[2] };
}

function formatWorkerAddress(address: WorkerAddress): string {
  assertSegment(address.nodeId, 'worker node');

  if (address.workflowRunId !== undefined) {
    assertSegment(address.workflowRunId, 'workflow run id');
    assertSegment(address.agentName, 'worker agent');
    return `${WORKER_PREFIX}${address.workflowRunId}/${address.nodeId}/${address.agentName}`;
  }

  if (address.agentName !== undefined) {
    assertSegment(address.agentName, 'worker agent');
    return `${WORKER_PREFIX}${address.nodeId}/${address.agentName}`;
  }

  return `${WORKER_PREFIX}${address.nodeId}`;
}

function assertSegment(value: string | undefined, label: string): asserts value is string {
  if (value === undefined || value.length === 0) {
    throw new Error(`Address ${label} cannot be empty`);
  }

  if (value.trim() !== value) {
    throw new Error(`Address ${label} cannot contain surrounding whitespace: ${value}`);
  }
}
