/**
 * API Helper Functions
 *
 * Typed convenience functions for common daemon operations.
 * These wrap MessageHub.call() with type safety and better DX.
 *
 * ## Non-Blocking Pattern:
 * All functions throw ConnectionNotReadyError immediately if not connected.
 * This prevents UI freezes when the connection is unstable.
 *
 * ## Usage:
 * ```typescript
 * try {
 *   const session = await createSession({ workspacePath: '/path' });
 * } catch (err) {
 *   if (err instanceof ConnectionNotReadyError) {
 *     toast.error('Not connected. Please wait...');
 *   } else {
 *     toast.error(err.message);
 *   }
 * }
 * ```
 */

import type {
  CreateSessionRequest,
  CreateSessionResponse,
  ListSessionsResponse,
  UpdateSessionRequest,
  ArchiveSessionResponse,
  GetAuthStatusResponse,
  CreateAppMcpServerRequest,
  UpdateAppMcpServerRequest,
  McpRegistryListResponse,
  McpRegistryCreateResponse,
  McpRegistryUpdateResponse,
  McpRegistryDeleteResponse,
  McpRegistrySetEnabledResponse,
  WorkspaceHistoryEntry,
  WorkspaceHistoryResponse,
  WorkspaceAddResponse,
  WorkspaceRemoveResponse,
  GitBranchesResponse,
  GitSessionStatusResponse,
  ProviderRecord,
  CreateProviderParams,
  UpdateProviderParams,
} from '@neokai/shared';
import type {
  ProviderAuthResponse,
  ListProviderAuthStatusResponse,
  ProviderRefreshResponse,
} from '@neokai/shared/provider';
import { connectionManager } from './connection-manager.ts';
import { ConnectionNotReadyError } from './errors.ts';

/**
 * Get hub or throw immediately (non-blocking helper)
 */
function getHubOrThrow() {
  const hub = connectionManager.getHubIfConnected();
  if (!hub) {
    throw new ConnectionNotReadyError('Not connected to server');
  }
  return hub;
}

// ==================== Session Operations ====================

export async function createSession(req: CreateSessionRequest): Promise<CreateSessionResponse> {
  const hub = getHubOrThrow();
  return await hub.request<CreateSessionResponse>('session.create', req, {
    timeout: 15000,
  });
}

export async function listSessions(): Promise<ListSessionsResponse> {
  const hub = getHubOrThrow();
  return await hub.request<ListSessionsResponse>('session.list');
}

export async function updateSession(sessionId: string, req: UpdateSessionRequest): Promise<void> {
  const hub = getHubOrThrow();
  await hub.request('session.update', { sessionId, ...req });
}

export async function resetSessionQuery(
  sessionId: string
): Promise<{ success: boolean; error?: string }> {
  const hub = getHubOrThrow();
  return await hub.request<{ success: boolean; error?: string }>('session.resetQuery', {
    sessionId,
    restartQuery: true,
  });
}

export async function cancelRateLimitRetry(sessionId: string): Promise<{ success: boolean }> {
  const hub = getHubOrThrow();
  return await hub.request<{ success: boolean }>('session.cancelRateLimitRetry', { sessionId });
}

export async function retryNowAfterRateLimit(sessionId: string): Promise<{ success: boolean }> {
  const hub = getHubOrThrow();
  return await hub.request<{ success: boolean }>('session.retryNowAfterRateLimit', { sessionId });
}

export async function switchCoordinatorMode(
  sessionId: string,
  coordinatorMode: boolean
): Promise<{ success: boolean; coordinatorMode: boolean; error?: string }> {
  const hub = getHubOrThrow();
  return await hub.request<{ success: boolean; coordinatorMode: boolean; error?: string }>(
    'session.coordinator.switch',
    { sessionId, coordinatorMode }
  );
}

export async function switchSandboxMode(
  sessionId: string,
  sandboxEnabled: boolean
): Promise<{ success: boolean; sandboxEnabled: boolean; error?: string }> {
  const hub = getHubOrThrow();
  return await hub.request<{ success: boolean; sandboxEnabled: boolean; error?: string }>(
    'session.sandbox.switch',
    { sessionId, sandboxEnabled }
  );
}

export async function deleteSession(sessionId: string): Promise<void> {
  const hub = getHubOrThrow();
  await hub.request('session.delete', { sessionId });
}

export async function archiveSession(
  sessionId: string,
  confirmed = false
): Promise<ArchiveSessionResponse> {
  const hub = getHubOrThrow();
  return await hub.request<ArchiveSessionResponse>('session.archive', {
    sessionId,
    confirmed,
  });
}

// ==================== Authentication ====================

export async function getAuthStatus(): Promise<GetAuthStatusResponse> {
  const hub = getHubOrThrow();
  return await hub.request<GetAuthStatusResponse>('auth.status');
}

// ==================== Provider Authentication ====================

export async function listProviderAuthStatus(): Promise<ListProviderAuthStatusResponse> {
  const hub = getHubOrThrow();
  return await hub.request<ListProviderAuthStatusResponse>('auth.providers', {});
}

export async function loginProvider(providerId: string): Promise<ProviderAuthResponse> {
  const hub = getHubOrThrow();
  return await hub.request<ProviderAuthResponse>('auth.login', { providerId });
}

export async function logoutProvider(
  providerId: string
): Promise<{ success: boolean; error?: string }> {
  const hub = getHubOrThrow();
  return await hub.request<{ success: boolean; error?: string }>('auth.logout', { providerId });
}

export async function refreshProvider(providerId: string): Promise<ProviderRefreshResponse> {
  const hub = getHubOrThrow();
  return await hub.request<ProviderRefreshResponse>('auth.refresh', { providerId });
}

// ==================== Unified Provider Registry ====================

export async function listProviders(): Promise<{
  providers: Array<ProviderRecord & { available: boolean }>;
}> {
  const hub = getHubOrThrow();
  return await hub.request<{ providers: Array<ProviderRecord & { available: boolean }> }>(
    'providers.list'
  );
}

export async function createProvider(
  params: CreateProviderParams,
  credentials?: {
    apiKey?: string;
    baseUrl?: string;
    oauthAccessToken?: string;
    oauthRefreshToken?: string;
    oauthExpiresAt?: number;
  }
): Promise<{ success: boolean; provider: ProviderRecord }> {
  const hub = getHubOrThrow();
  return await hub.request<{ success: boolean; provider: ProviderRecord }>('providers.create', {
    params,
    credentials,
  });
}

export async function updateProvider(
  id: string,
  params: Partial<UpdateProviderParams>,
  credentials?: {
    apiKey?: string;
    baseUrl?: string;
    oauthAccessToken?: string;
    oauthRefreshToken?: string;
    oauthExpiresAt?: number;
  }
): Promise<{ success: boolean; provider: ProviderRecord }> {
  const hub = getHubOrThrow();
  return await hub.request<{ success: boolean; provider: ProviderRecord }>('providers.update', {
    id,
    params,
    credentials,
  });
}

export async function deleteProvider(id: string): Promise<{ success: boolean }> {
  const hub = getHubOrThrow();
  return await hub.request<{ success: boolean }>('providers.delete', { id });
}

export async function setDefaultProvider(id: string): Promise<{ success: boolean }> {
  const hub = getHubOrThrow();
  return await hub.request<{ success: boolean }>('providers.setDefault', { id });
}

export async function testProvider(id: string): Promise<{ healthy: boolean; error?: string }> {
  const hub = getHubOrThrow();
  return await hub.request<{ healthy: boolean; error?: string }>('providers.test', { id });
}

// ==================== Settings Operations ====================

export async function updateGlobalSettings(
  updates: Partial<import('@neokai/shared').GlobalSettings>
): Promise<{
  success: boolean;
  settings: import('@neokai/shared').GlobalSettings;
}> {
  const hub = await connectionManager.getHub();
  return await hub.request<{
    success: boolean;
    settings: import('@neokai/shared').GlobalSettings;
  }>('settings.global.update', { updates });
}

/**
 * List runtime-attached (in-process, SDK-type) MCP servers for a session.
 * Covers space-agent-tools, db-query, task-agent, node-agent, and any other
 * MCPs injected via SpaceRuntimeService/TaskAgentManager at runtime.
 */
export async function listRuntimeMcpServers(
  sessionId: string
): Promise<import('@neokai/shared').ListRuntimeMcpServersResponse> {
  const hub = await connectionManager.getHub();
  return await hub.request<import('@neokai/shared').ListRuntimeMcpServersResponse>(
    'session.listRuntimeMcpServers',
    { sessionId }
  );
}

// ==================== Rewind Operations ====================

export async function getRewindPoints(sessionId: string): Promise<{
  rewindPoints: Array<{ uuid: string; timestamp: number; content: string; turnNumber: number }>;
  error?: string;
}> {
  const hub = getHubOrThrow();
  return await hub.request<{
    rewindPoints: Array<{ uuid: string; timestamp: number; content: string; turnNumber: number }>;
    error?: string;
  }>('rewind.checkpoints', { sessionId });
}

export async function previewRewind(
  sessionId: string,
  checkpointId: string
): Promise<{ preview: import('@neokai/shared').RewindPreview }> {
  const hub = getHubOrThrow();
  return await hub.request<{ preview: import('@neokai/shared').RewindPreview }>('rewind.preview', {
    sessionId,
    checkpointId,
  });
}

export async function executeRewind(
  sessionId: string,
  checkpointId: string,
  mode: import('@neokai/shared').RewindMode = 'files'
): Promise<{ result: import('@neokai/shared').RewindResult }> {
  const hub = getHubOrThrow();
  return await hub.request<{ result: import('@neokai/shared').RewindResult }>('rewind.execute', {
    sessionId,
    checkpointId,
    mode,
  });
}

// ==================== Selective Rewind Operations ====================

export async function executeSelectiveRewind(
  sessionId: string,
  messageIds: string[],
  mode: import('@neokai/shared').RewindMode = 'both'
): Promise<{ result: import('@neokai/shared').SelectiveRewindResult }> {
  const hub = getHubOrThrow();
  return await hub.request<{ result: import('@neokai/shared').SelectiveRewindResult }>(
    'rewind.executeSelective',
    { sessionId, messageIds, mode }
  );
}

// ==================== App MCP Registry Operations ====================

/** List all application-level MCP servers */
export async function listAppMcpServers(): Promise<McpRegistryListResponse> {
  const hub = getHubOrThrow();
  return await hub.request<McpRegistryListResponse>('mcp.registry.list');
}

/** Create a new application-level MCP server */
export async function createAppMcpServer(
  req: CreateAppMcpServerRequest
): Promise<McpRegistryCreateResponse> {
  const hub = getHubOrThrow();
  return await hub.request<McpRegistryCreateResponse>('mcp.registry.create', req);
}

/** Update an application-level MCP server */
export async function updateAppMcpServer(
  id: string,
  updates: Omit<UpdateAppMcpServerRequest, 'id'>
): Promise<McpRegistryUpdateResponse> {
  const hub = getHubOrThrow();
  return await hub.request<McpRegistryUpdateResponse>('mcp.registry.update', { id, ...updates });
}

/** Delete an application-level MCP server */
export async function deleteAppMcpServer(id: string): Promise<McpRegistryDeleteResponse> {
  const hub = getHubOrThrow();
  return await hub.request<McpRegistryDeleteResponse>('mcp.registry.delete', { id });
}

/** Enable or disable an application-level MCP server */
export async function setAppMcpServerEnabled(
  id: string,
  enabled: boolean
): Promise<McpRegistrySetEnabledResponse> {
  const hub = getHubOrThrow();
  return await hub.request<McpRegistrySetEnabledResponse>('mcp.registry.setEnabled', {
    id,
    enabled,
  });
}

// ==================== Workspace History Operations ====================

/** Get recently-used workspace paths from backend */
export async function getWorkspaceHistory(): Promise<WorkspaceHistoryEntry[]> {
  const hub = getHubOrThrow();
  const { entries } = await hub.request<WorkspaceHistoryResponse>('workspace.history', {});
  return entries;
}

/** Record a workspace path as recently used (upserts into backend history) */
export async function addWorkspaceToHistory(path: string): Promise<WorkspaceHistoryEntry> {
  const hub = getHubOrThrow();
  const { entry } = await hub.request<WorkspaceAddResponse>('workspace.add', { path });
  return entry;
}

/** Remove a workspace path from backend history */
export async function removeWorkspaceFromHistory(path: string): Promise<boolean> {
  const hub = getHubOrThrow();
  const { success } = await hub.request<WorkspaceRemoveResponse>('workspace.remove', { path });
  return success;
}

/** Get git context (repo detection, branches, current/default branch) for a folder path */
export async function getGitBranches(path: string): Promise<GitBranchesResponse> {
  const hub = getHubOrThrow();
  return await hub.request<GitBranchesResponse>('git.branches', { path });
}

/** Get read-only git status for a chat session's effective workspace */
export async function getGitSessionStatus(sessionId: string): Promise<GitSessionStatusResponse> {
  const hub = getHubOrThrow();
  return await hub.request<GitSessionStatusResponse>('git.sessionStatus', { sessionId });
}

// ==================== Session Workspace Operations ====================

/** Set workspace on an existing session via inline workspace selector */
export async function setSessionWorkspace(
  sessionId: string,
  workspacePath: string,
  worktreeMode: 'worktree' | 'direct'
): Promise<import('@neokai/shared').Session> {
  const hub = getHubOrThrow();
  const { session } = await hub.request<{
    success: boolean;
    session: import('@neokai/shared').Session;
  }>('session.setWorkspace', { sessionId, workspacePath, worktreeMode });
  return session;
}

// ==================== Custom Endpoints ====================

export async function listCustomEndpoints(): Promise<{
  endpoints: import('@neokai/shared').CustomEndpointConfig[];
}> {
  const hub = getHubOrThrow();
  return await hub.request<{ endpoints: import('@neokai/shared').CustomEndpointConfig[] }>(
    'customEndpoints.list'
  );
}

export async function addCustomEndpoint(
  endpoint: import('@neokai/shared').CustomEndpointConfig
): Promise<{ success: boolean; endpoint: import('@neokai/shared').CustomEndpointConfig }> {
  const hub = getHubOrThrow();
  return await hub.request('customEndpoints.add', { endpoint });
}

export async function updateCustomEndpoint(
  endpoint: import('@neokai/shared').CustomEndpointConfig
): Promise<{ success: boolean; endpoint: import('@neokai/shared').CustomEndpointConfig }> {
  const hub = getHubOrThrow();
  return await hub.request('customEndpoints.update', { endpoint });
}

export async function removeCustomEndpoint(id: string): Promise<{ success: boolean }> {
  const hub = getHubOrThrow();
  return await hub.request('customEndpoints.remove', { id });
}

export async function listCustomEndpointModels(data: {
  baseUrl: string;
  type?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}): Promise<{
  models: Array<{ id: string; name?: string }>;
  fromCache: boolean;
}> {
  const hub = getHubOrThrow();
  return await hub.request<{
    models: Array<{ id: string; name?: string }>;
    fromCache: boolean;
  }>('customEndpoints.listModels', data, { timeout: 15000 });
}
