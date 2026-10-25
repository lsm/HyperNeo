export type ObservedMcpStatus =
  | 'connected'
  | 'failed'
  | 'needs-auth'
  | 'pending'
  | 'disabled'
  | 'unverified';

export interface ObservedMcpServer {
  name: string;
  status: ObservedMcpStatus;
  tools: string[] | null;
}

export interface SessionToolInventory {
  state: 'not_running' | 'awaiting_init' | 'observed' | 'unverified';
  tools: string[];
  skills: string[];
  plugins: string[];
  mcpServers: ObservedMcpServer[];
}
