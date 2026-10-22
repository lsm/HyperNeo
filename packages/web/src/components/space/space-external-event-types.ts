export interface ExtensionConfig {
  source: string;
  globallyEnabled: boolean;
  capabilities: {
    webhooks?: boolean;
    polling?: boolean;
    rpcConfig?: boolean;
  };
  settings?: Record<string, unknown>;
}

export interface ExtensionStatus {
  source: string;
  status: 'started' | 'stopped';
  config: ExtensionConfig;
}

export interface GitHubWatchedRepo {
  id: string;
  owner: string;
  repo: string;
  enabled: boolean;
  webhookEnabled: boolean;
  pollingEnabled: boolean;
  webhookSecret: 'configured' | null;
  webhookRemoteId: number | null;
  webhookUrl: string | null;
  webhookAutoRegistered: boolean;
  webhookActive: boolean | null;
  webhookLastCheckedAt: number | null;
  webhookLastError: string | null;
  webhookConfiguredAt: number | null;
  lastWebhookAt: number | null;
  lastPollAt: number | null;
}

export interface GitHubSpaceConfig {
  spaceId: string;
  source: 'github';
  enabled: boolean;
  settings: Record<string, unknown>;
}

export interface GitHubTokenStatus {
  configured: boolean;
  source: 'keychain' | 'env' | 'gh' | 'none';
  login?: string;
  error?: string;
  autoRegisteredHookCount?: number;
}
