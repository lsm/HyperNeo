import type {
  ObservedMcpServer,
  ObservedMcpStatus,
  SessionToolInventory,
} from '@hyperneo/shared/types/observed-tool-inventory';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { QueryAttemptToken } from './query-attempt-token.ts';

interface InitObservation {
  tools: string[];
  skills: string[];
  plugins: { name: string }[];
  mcp_servers: ServerObservation[];
}

interface ServerObservation {
  name: string;
  status: string;
  tools?: { name: string }[];
}

const statuses = new Set<ObservedMcpStatus>([
  'connected',
  'failed',
  'needs-auth',
  'pending',
  'disabled',
]);

const names = (values: string[]) => [...new Set(values)];

function projectServer(server: ServerObservation): ObservedMcpServer {
  return {
    name: server.name,
    status: statuses.has(server.status as ObservedMcpStatus)
      ? (server.status as ObservedMcpStatus)
      : 'unverified',
    tools: server.tools ? names(server.tools.map((tool) => tool.name)) : null,
  };
}

function projectNames(observation: InitObservation) {
  return {
    tools: names(observation.tools),
    skills: names(observation.skills),
    plugins: names(observation.plugins.map((plugin) => plugin.name)),
  };
}

function projectInventory(
  observedNames: ReturnType<typeof projectNames>,
  observation: InitObservation
): SessionToolInventory {
  return {
    state: 'observed',
    ...observedNames,
    mcpServers: observation.mcp_servers.map(projectServer),
  };
}

const projectInit = (superpipe({})('observed-tool-inventory') as PipelineAPI)
  .input(['observation'])
  .pipe(projectNames, 'observation', 'names')
  .pipe(projectInventory, ['names', 'observation'], 'inventory')
  .end('inventory') as (observation: InitObservation) => SessionToolInventory;

function empty(state: SessionToolInventory['state']): SessionToolInventory {
  return { state, tools: [], skills: [], plugins: [], mcpServers: [] };
}

export class ObservedToolInventory {
  private owner: QueryAttemptToken | null = null;
  private inventory = empty('not_running');

  begin(token: QueryAttemptToken, provider: 'sdk' | 'acp'): void {
    if (!token.isLive()) return;
    this.owner = token;
    this.inventory = empty(provider === 'sdk' ? 'awaiting_init' : 'unverified');
  }

  captureInit(token: QueryAttemptToken, message: InitObservation): void {
    if (!this.owns(token) || this.inventory.state === 'unverified') return;
    this.inventory = projectInit(message);
  }

  captureStatus(token: QueryAttemptToken, servers: ServerObservation[]): void {
    if (!this.owns(token) || this.inventory.state !== 'observed') return;
    this.inventory = { ...this.inventory, mcpServers: servers.map(projectServer) };
  }

  end(token: QueryAttemptToken): void {
    if (this.owner !== token) return;
    this.owner = null;
    this.inventory = empty('not_running');
  }

  snapshot(): SessionToolInventory {
    return this.owner?.isLive() ? structuredClone(this.inventory) : empty('not_running');
  }

  private owns(token: QueryAttemptToken): boolean {
    return this.owner === token && token.isLive();
  }
}
