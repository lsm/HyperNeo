import type { ThinkingLevel } from '../types.ts';
import type { CustomEndpointConfig } from './custom-endpoint.ts';

export const MAX_GITHUB_POLLING_INTERVAL_SECONDS = Math.floor(2_147_483_647 / 1000);

export type SettingSource = 'user' | 'project' | 'local';

export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk';

export interface SDKSupportedSettings {
  model?: string;

  permissionMode?: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];

  maxThinkingTokens?: number | null;

  env?: Record<string, string>;

  maxTurns?: number;
  maxBudgetUsd?: number;

  sandbox?: {
    enabled?: boolean;
    autoAllowBashIfSandboxed?: boolean;
    excludedCommands?: string[];
    allowUnsandboxedCommands?: boolean;
    network?: {
      allowUnixSockets?: string[];
      allowLocalBinding?: boolean;
      allowedDomains?: string[];
      allowAllUnixSockets?: boolean;
      httpProxyPort?: number;
      socksProxyPort?: number;
    };
  };

  betas?: Array<'context-1m-2025-08-07'>;

  systemPrompt?: string;
}

export interface FileOnlySettings {
  askPermissions?: string[];

  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;

  outputStyle?: string;
  showArchived?: boolean;

  attribution?: {
    commit?: string;
    pr?: string;
  };

  outputLimiter?: {
    enabled?: boolean;
    bash?: {
      headLines?: number;
      tailLines?: number;
      excludedCommandPrefixes?: string[];
    };
    read?: {
      maxLines?: number;
    };
    grep?: {
      maxMatches?: number;
    };
    excludeTools?: string[];
  };
}

export interface FallbackModelEntry {
  model: string;
  provider: string;
}

export interface VoiceSettings {
  enabled: boolean;
  endpoint: string;
  model: string;
  apiKey?: string;
  hasApiKey?: boolean;
  apiKeyEndpoint?: string;
  allowInsecureTls?: boolean;
  allowPrivateNetwork?: boolean;
}

export const VOICE_MAX_AUDIO_BYTES = 10 * 1024 * 1024;

export interface GlobalSettings extends SDKSupportedSettings, FileOnlySettings {
  settingSources: SettingSource[];

  providerModelAllowlists?: Record<string, string[]>;

  thinkingLevel?: ThinkingLevel;

  autoScroll?: boolean;

  githubPollingInterval?: number;

  coordinatorMode?: boolean;

  sdkMessageRetentionDays?: number;

  maxConcurrentWorkers?: number;

  fallbackModels?: FallbackModelEntry[];

  modelFallbackMap?: Record<string, FallbackModelEntry[]>;

  customEndpoints?: CustomEndpointConfig[];

  voice?: VoiceSettings;
}

export interface SessionSettings extends GlobalSettings {
  sessionId: string;
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  settingSources: ['user', 'project', 'local'],
  permissionMode: 'default',
  model: 'sonnet',
  showArchived: false,
  autoScroll: true,
  githubPollingInterval: 120,
  voice: {
    enabled: false,
    endpoint: '',
    model: '',
    allowInsecureTls: false,
    allowPrivateNetwork: false,
  },
  coordinatorMode: false,
  maxConcurrentWorkers: 3,
  sandbox: {
    enabled: true,
    autoAllowBashIfSandboxed: true,
    excludedCommands: ['git'],
    network: {
      allowedDomains: [
        'github.com',
        '*.github.com',
        'gist.github.com',
        '*.npmjs.org',
        'registry.npmjs.org',
        '*.yarnpkg.com',
        'registry.yarnpkg.com',
        'packages.gitlab.com',
        '*.pkg.dev',
        'go.dev',
        'crates.io',
        'pypi.org',
        '*.pypi.org',
        'rubygems.org',
        '*.rubygems.org',
        '*.maven.org',
        '*.gradle.org',
        'cdn.jsdelivr.net',
        '*.cloudflare.com',
        'openai.com',
        '*.openai.com',
        'anthropic.com',
        '*.anthropic.com',
        'openrouter.ai',
        '*.openrouter.ai',
        '*.google.dev',
        '*.google.com',
        '*.googleapis.com',
        '*.googleusercontent.com',
        '*.gcp.goog',
        '*.run.app',
        '*.appspot.com',
        '*.cloudfunctions.net',
        'cohere.com',
        '*.cohere.com',
        'mistral.ai',
        '*.mistral.ai',
        'huggingface.co',
        '*.huggingface.co',
        'replicate.com',
        '*.replicate.com',
        'together.ai',
        '*.together.ai',
        'api.together.xyz',
        'groq.com',
        '*.groq.com',
      ],
      allowLocalBinding: true,
      allowAllUnixSockets: true,
    },
  },
  outputLimiter: {
    enabled: true,
    bash: {
      headLines: 100,
      tailLines: 200,
      excludedCommandPrefixes: [],
    },
    read: {
      maxLines: 1000,
    },
    grep: {
      maxMatches: 250,
    },
    excludeTools: [],
  },
};

export interface McpServerInfo {
  name: string;
  status: 'connected' | 'failed' | 'pending' | 'disabled';
  enabled: boolean;
  description?: string;
}
