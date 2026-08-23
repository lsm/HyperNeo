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
  GitFileDiffResponse,
  ProviderRecord,
  CreateProviderParams,
  UpdateProviderParams,
} from '@hyperneo/shared';
import type {
  ProviderAuthResponse,
  ProviderLogoutResponse,
  ListProviderAuthStatusResponse,
  ProviderRefreshResponse,
} from '@hyperneo/shared/provider';
import { connectionManager } from './connection-manager.ts';
import { ConnectionNotReadyError } from './errors.ts';

function getHubOrThrow() {
  const hub = connectionManager.getHubIfConnected();
  if (!hub) {
    throw new ConnectionNotReadyError('Not connected to server');
  }
  return hub;
}

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

export async function retryMessageDelivery(
  sessionId: string,
  messageDbId: string
): Promise<{ retried: boolean; messageId?: string; status?: string }> {
  const hub = getHubOrThrow();
  return await hub.request<{ retried: boolean; messageId?: string; status?: string }>(
    'session.messages.retry',
    { sessionId, messageDbId }
  );
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

export async function getAuthStatus(): Promise<GetAuthStatusResponse> {
  const hub = getHubOrThrow();
  return await hub.request<GetAuthStatusResponse>('auth.status');
}

export async function listProviderAuthStatus(): Promise<ListProviderAuthStatusResponse> {
  const hub = getHubOrThrow();
  return await hub.request<ListProviderAuthStatusResponse>('auth.providers', {});
}

export async function loginProvider(providerId: string): Promise<ProviderAuthResponse> {
  const hub = getHubOrThrow();
  return await hub.request<ProviderAuthResponse>('auth.login', { providerId });
}

export async function logoutProvider(providerId: string): Promise<ProviderLogoutResponse> {
  const hub = getHubOrThrow();
  return await hub.request<ProviderLogoutResponse>('auth.logout', { providerId });
}

export async function refreshProvider(providerId: string): Promise<ProviderRefreshResponse> {
  const hub = getHubOrThrow();
  return await hub.request<ProviderRefreshResponse>('auth.refresh', { providerId });
}

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
  return await hub.request<{ success: boolean; provider: ProviderRecord }>(
    'providers.update',
    {
      id,
      params,
      credentials,
    },
    { timeout: 35000 }
  );
}

export async function deleteProvider(id: string): Promise<{ success: boolean }> {
  const hub = getHubOrThrow();
  return await hub.request<{ success: boolean }>('providers.delete', { id });
}

export async function setDefaultProvider(id: string): Promise<{ success: boolean }> {
  const hub = getHubOrThrow();
  return await hub.request<{ success: boolean }>('providers.setDefault', { id });
}

export async function fetchAcpModels(
  id: string,
  command?: string
): Promise<{ models: Array<{ id: string; name?: string }> }> {
  const hub = getHubOrThrow();
  return await hub.request<{ models: Array<{ id: string; name?: string }> }>(
    'providers.fetchAcpModels',
    { id, command },
    { timeout: 30000 }
  );
}

export async function testProvider(id: string): Promise<{ healthy: boolean; error?: string }> {
  const hub = getHubOrThrow();
  return await hub.request<{ healthy: boolean; error?: string }>(
    'providers.test',
    { id },
    {
      timeout: 25000,
    }
  );
}

export async function updateGlobalSettings(
  updates: Partial<import('@hyperneo/shared').GlobalSettings>,
  options?: { timeout?: number }
): Promise<{
  success: boolean;
  settings: import('@hyperneo/shared').GlobalSettings;
}> {
  const hub = await connectionManager.getHub();
  return await hub.request<{
    success: boolean;
    settings: import('@hyperneo/shared').GlobalSettings;
  }>('settings.global.update', { updates }, options);
}

export async function listRuntimeMcpServers(
  sessionId: string
): Promise<import('@hyperneo/shared').ListRuntimeMcpServersResponse> {
  const hub = await connectionManager.getHub();
  return await hub.request<import('@hyperneo/shared').ListRuntimeMcpServersResponse>(
    'session.listRuntimeMcpServers',
    { sessionId }
  );
}

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
): Promise<{ preview: import('@hyperneo/shared').RewindPreview }> {
  const hub = getHubOrThrow();
  return await hub.request<{ preview: import('@hyperneo/shared').RewindPreview }>(
    'rewind.preview',
    {
      sessionId,
      checkpointId,
    }
  );
}

export async function executeRewind(
  sessionId: string,
  checkpointId: string,
  mode: import('@hyperneo/shared').RewindMode = 'files'
): Promise<{ result: import('@hyperneo/shared').RewindResult }> {
  const hub = getHubOrThrow();
  return await hub.request<{ result: import('@hyperneo/shared').RewindResult }>('rewind.execute', {
    sessionId,
    checkpointId,
    mode,
  });
}

export async function executeSelectiveRewind(
  sessionId: string,
  messageIds: string[],
  mode: import('@hyperneo/shared').RewindMode = 'both'
): Promise<{ result: import('@hyperneo/shared').SelectiveRewindResult }> {
  const hub = getHubOrThrow();
  return await hub.request<{ result: import('@hyperneo/shared').SelectiveRewindResult }>(
    'rewind.executeSelective',
    { sessionId, messageIds, mode }
  );
}

export async function listAppMcpServers(): Promise<McpRegistryListResponse> {
  const hub = getHubOrThrow();
  return await hub.request<McpRegistryListResponse>('mcp.registry.list');
}

export async function createAppMcpServer(
  req: CreateAppMcpServerRequest
): Promise<McpRegistryCreateResponse> {
  const hub = getHubOrThrow();
  return await hub.request<McpRegistryCreateResponse>('mcp.registry.create', req);
}

export async function updateAppMcpServer(
  id: string,
  updates: Omit<UpdateAppMcpServerRequest, 'id'>
): Promise<McpRegistryUpdateResponse> {
  const hub = getHubOrThrow();
  return await hub.request<McpRegistryUpdateResponse>('mcp.registry.update', { id, ...updates });
}

export async function deleteAppMcpServer(id: string): Promise<McpRegistryDeleteResponse> {
  const hub = getHubOrThrow();
  return await hub.request<McpRegistryDeleteResponse>('mcp.registry.delete', { id });
}

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

export async function getWorkspaceHistory(): Promise<WorkspaceHistoryEntry[]> {
  const hub = getHubOrThrow();
  const { entries } = await hub.request<WorkspaceHistoryResponse>('workspace.history', {});
  return entries;
}

export async function addWorkspaceToHistory(path: string): Promise<WorkspaceHistoryEntry> {
  const hub = getHubOrThrow();
  const { entry } = await hub.request<WorkspaceAddResponse>('workspace.add', { path });
  return entry;
}

export async function removeWorkspaceFromHistory(path: string): Promise<boolean> {
  const hub = getHubOrThrow();
  const { success } = await hub.request<WorkspaceRemoveResponse>('workspace.remove', { path });
  return success;
}

export async function getGitBranches(path: string): Promise<GitBranchesResponse> {
  const hub = getHubOrThrow();
  return await hub.request<GitBranchesResponse>('git.branches', { path });
}

export async function getGitSessionStatus(sessionId: string): Promise<GitSessionStatusResponse> {
  const hub = getHubOrThrow();
  return await hub.request<GitSessionStatusResponse>(
    'git.sessionStatus',
    { sessionId },
    { timeout: 25_000 }
  );
}

export async function getGitFileDiff(
  sessionId: string,
  path: string
): Promise<GitFileDiffResponse> {
  const hub = getHubOrThrow();
  return await hub.request<GitFileDiffResponse>(
    'git.fileDiff',
    { sessionId, path },
    { timeout: 20_000 }
  );
}

export async function setSessionWorkspace(
  sessionId: string,
  workspacePath: string,
  worktreeMode: 'worktree' | 'direct'
): Promise<import('@hyperneo/shared').Session> {
  const hub = getHubOrThrow();
  const { session } = await hub.request<{
    success: boolean;
    session: import('@hyperneo/shared').Session;
  }>('session.setWorkspace', { sessionId, workspacePath, worktreeMode });
  return session;
}

export async function listCustomEndpoints(): Promise<{
  endpoints: import('@hyperneo/shared').CustomEndpointConfig[];
}> {
  const hub = getHubOrThrow();
  return await hub.request<{ endpoints: import('@hyperneo/shared').CustomEndpointConfig[] }>(
    'customEndpoints.list'
  );
}

export async function addCustomEndpoint(
  endpoint: import('@hyperneo/shared').CustomEndpointConfig
): Promise<{ success: boolean; endpoint: import('@hyperneo/shared').CustomEndpointConfig }> {
  const hub = getHubOrThrow();
  return await hub.request('customEndpoints.add', { endpoint });
}

export async function updateCustomEndpoint(
  endpoint: import('@hyperneo/shared').CustomEndpointConfig
): Promise<{ success: boolean; endpoint: import('@hyperneo/shared').CustomEndpointConfig }> {
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
  force?: boolean;
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
