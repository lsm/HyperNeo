export const OPERATIONS_MCP_SERVER_NAME = 'hyperneo-operations';

const BUILT_IN_MCP_SERVERS: ReadonlySet<string> = new Set([
  'agent-memory',
  'db-query',
  OPERATIONS_MCP_SERVER_NAME,
]);

function isBuiltInMcpServerName(name: string): boolean {
  return BUILT_IN_MCP_SERVERS.has(name);
}

export function reservedMcpRenameSource(attachedName: string): string {
  const match = /^(.+)-\d+$/.exec(attachedName);
  if (match && isBuiltInMcpServerName(match[1])) return match[1];
  return attachedName;
}

export function isBuiltInMcpServer(name: string, config: unknown): boolean {
  if (!isBuiltInMcpServerName(name)) return false;
  if (!config || typeof config !== 'object') return false;
  const server = config as { type?: string; instance?: unknown };
  return server.type === 'sdk' && !!server.instance;
}

interface ReservedMcpServerRename {
  from: string;
  to: string;
}

interface MergeSessionMcpServersInput<T> {
  registryServers?: Record<string, T>;
  skillServers?: Record<string, T>;
  runtimeServers?: Record<string, T>;
  operationServer?: T;
}

interface MergeSessionMcpServersResult<T> {
  servers: Record<string, T>;
  renamed: ReservedMcpServerRename[];
}

export function mergeSessionMcpServers<T>(
  input: MergeSessionMcpServersInput<T>
): MergeSessionMcpServersResult<T> {
  const servers: Record<string, T> = {};
  const displaced = new Map<string, T>();

  for (const layer of [input.registryServers, input.skillServers, input.runtimeServers]) {
    for (const [name, config] of Object.entries(layer ?? {})) {
      if (isBuiltInMcpServerName(name) && !isBuiltInMcpServer(name, config)) {
        displaced.set(name, config);
        continue;
      }
      servers[name] = config;
    }
  }

  if (input.operationServer !== undefined) {
    servers[OPERATIONS_MCP_SERVER_NAME] = input.operationServer;
  }

  const renamed: ReservedMcpServerRename[] = [];
  for (const [name, config] of displaced) {
    let suffix = 2;
    let candidate = `${name}-${suffix}`;
    while (Object.hasOwn(servers, candidate)) {
      suffix += 1;
      candidate = `${name}-${suffix}`;
    }
    servers[candidate] = config;
    renamed.push({ from: name, to: candidate });
  }

  return { servers, renamed };
}
