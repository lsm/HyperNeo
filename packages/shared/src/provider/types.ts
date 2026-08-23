import type { ModelInfo } from '../models.js';

export type ModelTier = 'sonnet' | 'haiku' | 'opus' | 'default';

export type ProviderId = string;

export interface ProviderCapabilities {
  streaming: boolean;
  extendedThinking: boolean;
  thinkingModes: 'off' | 'on' | 'granular';
  maxContextWindow: number;
  functionCalling: boolean;
  vision: boolean;
}

export interface ProviderSdkConfig {
  envVars: Record<string, string>;
  sdkOptions?: Record<string, unknown>;
  isAnthropicCompatible: boolean;
  apiVersion?: string;
}

export type ProviderCredentials =
  | { type: 'api_key'; apiKey: string }
  | {
      type: 'oauth';
      accessToken?: string;
      refreshToken?: string;
      expiresAt?: number;
      raw?: Record<string, unknown>;
    };

export interface ProviderSessionConfig {
  apiKey?: string;
  baseUrl?: string;
  region?: unknown;
  workspacePath?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface ProviderAuthStatusInfo {
  isAuthenticated: boolean;
  method?: 'api_key' | 'oauth';
  expiresAt?: number;
  needsRefresh?: boolean;
  user?: {
    email?: string;
    name?: string;
  };
  error?: string;
}

export interface ProviderOAuthFlowData {
  type: 'redirect' | 'device';
  authUrl?: string;
  userCode?: string;
  verificationUri?: string;
  message: string;
}

export interface Provider {
  readonly id: ProviderId;

  readonly displayName: string;

  readonly capabilities: ProviderCapabilities;

  isAvailable(): Promise<boolean> | boolean;

  getModels(): Promise<ModelInfo[]>;

  getCachedModels?(): ModelInfo[] | null;

  ownsModel(modelId: string): boolean;

  getModelForTier(tier: ModelTier): string | undefined;

  buildSdkConfig(modelId: string, sessionConfig?: ProviderSessionConfig): ProviderSdkConfig;

  translateModelIdForSdk?(modelId: string): string;

  getTitleGenerationModel?(): string;

  getAuthStatus?(): Promise<ProviderAuthStatusInfo>;

  setCredentials?(credentials: ProviderCredentials): void;

  getCredentials?(): Promise<ProviderCredentials | null> | ProviderCredentials | null;

  onCredentialsChanged?(
    listener: (credentials: ProviderCredentials) => void | Promise<void>
  ): () => void;

  startOAuthFlow?(): Promise<ProviderOAuthFlowData>;

  logout?(): Promise<void>;

  refreshToken?(): Promise<boolean>;

  setSessionThinkingConfig?(
    sessionId: string,
    thinkingLevel: string | undefined
  ): void | Promise<void>;

  shutdown?(): Promise<void>;

  clearModelCache?(): void;

  getModelThinkingMode?(modelId: string): 'off' | 'on' | 'granular' | undefined;
}

export interface ProviderContext {
  readonly provider: Provider;
  readonly sdkConfig: ProviderSdkConfig;
  readonly modelId: string;
  readonly sessionConfig?: ProviderSessionConfig;

  getSdkModelId(): string;

  buildSdkOptions<T extends Record<string, unknown>>(baseOptions: T): Promise<T>;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  available: boolean;
  capabilities: ProviderCapabilities;
  models: string[];
}
