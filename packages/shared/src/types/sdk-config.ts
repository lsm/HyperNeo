import type { SettingSource, PermissionMode } from './settings.ts';

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' };

export interface ModelSettings {
  model?: string;
  fallbackModel?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  maxThinkingTokens?: number | null;
  thinking?: ThinkingConfig;
}

export interface ClaudeCodePreset {
  type: 'preset';
  preset: 'claude_code';
  append?: string;
}

export type SystemPromptConfig = string | ClaudeCodePreset;

export interface ToolsPreset {
  type: 'preset';
  preset: 'claude_code';
}

export type ToolsPresetConfig = string[] | ToolsPreset;

export interface ToolsSettings {
  tools?: ToolsPresetConfig;
  allowedTools?: string[];
  disallowedTools?: string[];
}

export type AgentModel = 'sonnet' | 'opus' | 'haiku' | 'fable' | 'inherit' | (string & {});

export interface AgentMcpServerSpec {
  name: string;
  include?: boolean;
}

export interface AgentDefinition {
  description: string;
  tools?: string[];
  disallowedTools?: string[];
  prompt: string;
  model?: AgentModel;
  permissionMode?: PermissionMode;
  mcpServers?: AgentMcpServerSpec[];
  criticalSystemReminder_EXPERIMENTAL?: string;
}

export interface AgentsConfig {
  agents?: Record<string, AgentDefinition>;
}

export interface NetworkSandboxSettings {
  allowLocalBinding?: boolean;
  allowUnixSockets?: string[];
  allowAllUnixSockets?: boolean;
  httpProxyPort?: number;
  socksProxyPort?: number;
  allowedDomains?: string[];
}

export interface SandboxIgnoreViolations {
  file?: string[];
  network?: string[];
}

export interface SandboxSettings {
  enabled?: boolean;
  autoAllowBashIfSandboxed?: boolean;
  excludedCommands?: string[];
  allowUnsandboxedCommands?: boolean;
  network?: NetworkSandboxSettings;
  ignoreViolations?: SandboxIgnoreViolations;
  enableWeakerNestedSandbox?: boolean;
}

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpSSEServerConfig {
  type: 'sse';
  url: string;
  headers?: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;

export interface McpSettings {
  mcpServers?: Record<string, McpServerConfig>;
  strictMcpConfig?: boolean;
}

export interface OutputFormatConfig {
  type: 'json_schema';
  schema: Record<string, unknown>;
}

export interface PluginConfig {
  type: 'local';
  path: string;
}

export type SdkBeta = 'context-1m-2025-08-07';

export interface EnvironmentSettings {
  cwd?: string;
  additionalDirectories?: string[];
  env?: Record<string, string>;
  executable?: 'bun' | 'deno' | 'node';
  executableArgs?: string[];
  pathToClaudeCodeExecutable?: string;
}

export interface SessionResumptionSettings {
  resume?: string;
  resumeSessionAt?: string;
  forkSession?: boolean;
  continue?: boolean;
  enableFileCheckpointing?: boolean;
}

export interface SDKConfig
  extends ModelSettings,
    ToolsSettings,
    AgentsConfig,
    McpSettings,
    EnvironmentSettings,
    SessionResumptionSettings {
  agent?: string;

  systemPrompt?: SystemPromptConfig;

  permissionMode?: PermissionMode;

  allowDangerouslySkipPermissions?: boolean;

  sandbox?: SandboxSettings;

  outputFormat?: OutputFormatConfig;

  plugins?: PluginConfig[];

  betas?: SdkBeta[];

  settingSources?: SettingSource[];

  includePartialMessages?: boolean;
}

export interface ConfigUpdateResult {
  applied: string[];
  pending: string[];
  errors: Array<{
    field: string;
    error: string;
  }>;
}

export interface ValidationResult {
  valid: boolean;
  error?: string;
}
