export type McpEnablementScopeType = 'space' | 'room' | 'session';

export interface McpEnablementOverride {
  scopeType: McpEnablementScopeType;
  scopeId: string;
  serverId: string;
  enabled: boolean;
}

export interface McpEnablementListRequest {
  scopeType: McpEnablementScopeType;
  scopeId: string;
}

export interface McpEnablementListResponse {
  overrides: McpEnablementOverride[];
}

export interface McpEnablementSetOverrideRequest {
  scopeType: McpEnablementScopeType;
  scopeId: string;
  serverId: string;
  enabled: boolean;
}

export interface McpEnablementSetOverrideResponse {
  override: McpEnablementOverride;
}

export interface McpEnablementClearOverrideRequest {
  scopeType: McpEnablementScopeType;
  scopeId: string;
  serverId: string;
}

export interface McpEnablementClearOverrideResponse {
  deleted: boolean;
}

export interface McpEnablementClearScopeRequest {
  scopeType: McpEnablementScopeType;
  scopeId: string;
}

export interface McpEnablementClearScopeResponse {
  deleted: number;
}

export type McpEffectiveEnablementSource = 'session' | 'room' | 'space' | 'registry';

export interface SessionMcpServerEntry {
  server: import('./app-mcp-server.ts').AppMcpServer;
  enabled: boolean;
  source: McpEffectiveEnablementSource;
  override?: McpEnablementOverride;
}

export interface SessionMcpListRequest {
  sessionId: string;
}

export interface SessionMcpListResponse {
  entries: SessionMcpServerEntry[];
}
