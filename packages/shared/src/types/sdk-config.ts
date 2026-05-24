/**
 * SDK Configuration Types
 *
 * Comprehensive type definitions for all Claude Agent SDK Options.
 * These types map directly to the SDK's Options interface and enable
 * full configuration of agent sessions via RPC.
 *
 * Excludes: hooks, canUseTool, abortController (runtime-only callbacks)
 */

import type { SettingSource, PermissionMode } from './settings.ts';

// ============================================================================
// Model & Execution Settings
// ============================================================================

/**
 * Thinking/reasoning configuration for Claude
 * Replaces deprecated maxThinkingTokens
 */
export type ThinkingConfig =
  | { type: 'adaptive' } // Claude decides (Opus 4.6+ default)
  | { type: 'enabled'; budgetTokens: number } // Fixed token budget
  | { type: 'disabled' }; // No extended thinking

/**
 * Model and execution configuration
 */
export interface ModelSettings {
  /** Model ID (e.g., 'claude-sonnet-4-5-20250929') */
  model?: string;
  /** Fallback model to use if primary fails */
  fallbackModel?: string;
  /** Maximum conversation turns before stopping */
  maxTurns?: number;
  /** Maximum budget in USD - stops if exceeded */
  maxBudgetUsd?: number;
  /** @deprecated Use thinking instead. Max tokens for extended thinking (null = disabled) */
  maxThinkingTokens?: number | null;
  /** NEW: Thinking configuration (preferred over maxThinkingTokens) */
  thinking?: ThinkingConfig;
}

// ============================================================================
// System Prompt Configuration
// ============================================================================

/**
 * Claude Code system prompt preset configuration
 */
export interface ClaudeCodePreset {
  type: 'preset';
  preset: 'claude_code';
  /** Text appended to the default Claude Code system prompt */
  append?: string;
}

/**
 * System prompt configuration - either custom string or Claude Code preset
 */
export type SystemPromptConfig = string | ClaudeCodePreset;

// ============================================================================
// Tools Configuration
// ============================================================================

/**
 * Claude Code tools preset configuration
 */
export interface ToolsPreset {
  type: 'preset';
  preset: 'claude_code';
}

/**
 * Tools configuration - either array of tool names or preset
 */
export type ToolsPresetConfig = string[] | ToolsPreset;

/**
 * Tools configuration settings
 */
export interface ToolsSettings {
  /** Tool configuration - array of tool names or preset */
  tools?: ToolsPresetConfig;
  /** Tools to auto-allow without permission prompts */
  allowedTools?: string[];
  /** Tools to disable entirely */
  disallowedTools?: string[];
}

// ============================================================================
// Agent/Subagent Configuration
// ============================================================================

/**
 * Model options for agents/subagents
 */
export type AgentModel = 'sonnet' | 'opus' | 'haiku' | 'inherit';

/**
 * MCP server specification for agents
 */
export interface AgentMcpServerSpec {
  /** Server name */
  name: string;
  /** Whether to include this server (true) or exclude (false) */
  include?: boolean;
}

/**
 * Agent/subagent definition
 */
export interface AgentDefinition {
  /** Description of when to use this agent */
  description: string;
  /** Allowed tools (inherits parent if omitted) */
  tools?: string[];
  /** Explicitly disallowed tools */
  disallowedTools?: string[];
  /** Agent system prompt */
  prompt: string;
  /** Model override for this agent */
  model?: AgentModel;
  /** Permission mode override for this agent */
  permissionMode?: PermissionMode;
  /** MCP servers for this agent */
  mcpServers?: AgentMcpServerSpec[];
  /** Critical system reminder (experimental) */
  criticalSystemReminder_EXPERIMENTAL?: string;
}

/**
 * Agents configuration - map of agent name to definition
 */
export interface AgentsConfig {
  agents?: Record<string, AgentDefinition>;
}

// ============================================================================
// Sandbox Configuration
// ============================================================================

/**
 * Network sandbox settings
 */
export interface NetworkSandboxSettings {
  /** Allow binding to local ports */
  allowLocalBinding?: boolean;
  /** Unix socket paths to allow */
  allowUnixSockets?: string[];
  /** Allow all Unix sockets */
  allowAllUnixSockets?: boolean;
  /** HTTP proxy port */
  httpProxyPort?: number;
  /** SOCKS proxy port */
  socksProxyPort?: number;
  /** Allowed network domains */
  allowedDomains?: string[];
}

/**
 * Sandbox violation ignore patterns
 */
export interface SandboxIgnoreViolations {
  /** File path patterns to ignore */
  file?: string[];
  /** Network patterns to ignore */
  network?: string[];
}

/**
 * Sandbox configuration settings
 */
export interface SandboxSettings {
  /** Enable sandbox mode */
  enabled?: boolean;
  /** Auto-approve bash commands in sandbox */
  autoAllowBashIfSandboxed?: boolean;
  /** Commands that bypass sandbox */
  excludedCommands?: string[];
  /** Allow model to request unsandboxed execution */
  allowUnsandboxedCommands?: boolean;
  /** Network sandbox configuration */
  network?: NetworkSandboxSettings;
  /** Violations to ignore */
  ignoreViolations?: SandboxIgnoreViolations;
  /** Enable weaker nested sandbox */
  enableWeakerNestedSandbox?: boolean;
}

// ============================================================================
// MCP Server Configuration
// ============================================================================

/**
 * Stdio MCP server configuration
 */
export interface McpStdioServerConfig {
  type?: 'stdio';
  /** Command to execute */
  command: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
}

/**
 * SSE (Server-Sent Events) MCP server configuration
 */
export interface McpSSEServerConfig {
  type: 'sse';
  /** Server URL */
  url: string;
  /** HTTP headers */
  headers?: Record<string, string>;
}

/**
 * HTTP MCP server configuration
 */
export interface McpHttpServerConfig {
  type: 'http';
  /** Server URL */
  url: string;
  /** HTTP headers */
  headers?: Record<string, string>;
}

/**
 * MCP server configuration - stdio, SSE, or HTTP
 */
export type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;

/**
 * MCP configuration settings
 */
export interface McpSettings {
  /** MCP servers configuration */
  mcpServers?: Record<string, McpServerConfig>;
  /** Enforce strict MCP validation */
  strictMcpConfig?: boolean;
}

// ============================================================================
// Output Format (Structured Outputs)
// ============================================================================

/**
 * JSON schema output format configuration
 */
export interface OutputFormatConfig {
  type: 'json_schema';
  /** JSON Schema definition for structured output */
  schema: Record<string, unknown>;
}

// ============================================================================
// Plugins Configuration
// ============================================================================

/**
 * Local plugin configuration
 */
export interface PluginConfig {
  type: 'local';
  /** Absolute or relative path to plugin directory */
  path: string;
}

// ============================================================================
// Beta Features
// ============================================================================

/**
 * Available SDK beta features
 */
export type SdkBeta = 'context-1m-2025-08-07';

// ============================================================================
// Environment & Execution Settings
// ============================================================================

/**
 * Environment and execution configuration
 */
export interface EnvironmentSettings {
  /** Working directory (defaults to process.cwd()) */
  cwd?: string;
  /** Additional accessible directories */
  additionalDirectories?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** JavaScript runtime to use */
  executable?: 'bun' | 'deno' | 'node';
  /** Runtime arguments */
  executableArgs?: string[];
  /** Path to Claude Code executable (uses SDK bundled version if not specified) */
  pathToClaudeCodeExecutable?: string;
}

// ============================================================================
// Session Resumption Settings
// ============================================================================

/**
 * Session resumption and continuation settings
 */
export interface SessionResumptionSettings {
  /** Session ID to resume */
  resume?: string;
  /** Resume at specific message UUID */
  resumeSessionAt?: string;
  /** Fork to new session when resuming */
  forkSession?: boolean;
  /** Continue most recent conversation */
  continue?: boolean;
  /** Enable file change tracking for rewind capability */
  enableFileCheckpointing?: boolean;
}

// ============================================================================
// Complete SDK Configuration
// ============================================================================

/**
 * Complete SDK configuration interface
 *
 * This interface encompasses all configurable SDK Options, enabling
 * full control over agent session behavior via RPC.
 */
export interface SDKConfig
  extends ModelSettings,
    ToolsSettings,
    AgentsConfig,
    McpSettings,
    EnvironmentSettings,
    SessionResumptionSettings {
  /** Agent name for the main thread (coordinator mode) */
  agent?: string;

  /** System prompt configuration */
  systemPrompt?: SystemPromptConfig;

  /** Permission mode for SDK operations */
  permissionMode?: PermissionMode;

  /** Required when using 'bypassPermissions' mode */
  allowDangerouslySkipPermissions?: boolean;

  /** Sandbox configuration */
  sandbox?: SandboxSettings;

  /** Structured output format configuration */
  outputFormat?: OutputFormatConfig;

  /** Plugin configurations */
  plugins?: PluginConfig[];

  /** Beta feature flags */
  betas?: SdkBeta[];

  /** Setting sources to load */
  settingSources?: SettingSource[];

  /** Include streaming partial messages */
  includePartialMessages?: boolean;
}

// ============================================================================
// Runtime Change Classification
// ============================================================================

// Config Update Result Types
// ============================================================================

/**
 * Result of a configuration update operation
 */
export interface ConfigUpdateResult {
  /** Fields that were applied immediately */
  applied: string[];
  /** Fields pending query restart to apply */
  pending: string[];
  /** Errors that occurred during update */
  errors: Array<{
    field: string;
    error: string;
  }>;
}

/**
 * Validation result for configuration
 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
}
