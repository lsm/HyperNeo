/**
 * ACP (Agent Client Protocol) type definitions
 *
 * JSON-RPC 2.0 over stdio protocol for editor-to-agent communication.
 * Foundation layer for ACP provider support in NeoKai.
 */

// ============================================================================
// JSON-RPC 2.0 Base Types
// ============================================================================

export interface AcpJsonRpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: T;
}

export interface AcpJsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: T;
  error?: AcpJsonRpcError;
}

export interface AcpJsonRpcNotification<T = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: T;
}

export interface AcpJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// ============================================================================
// Initialization
// ============================================================================

export interface AcpInitializeParams {
  protocolVersion: string;
  capabilities: AcpClientCapabilities;
  clientInfo: {
    name: string;
    version: string;
  };
}

export interface AcpInitializeResult {
  protocolVersion: string;
  capabilities: AcpAgentCapabilities;
  serverInfo: {
    name: string;
    version: string;
  };
}

export interface AcpClientCapabilities {
  experimental?: Record<string, unknown>;
}

export interface AcpAgentCapabilities {
  experimental?: Record<string, unknown>;
}

// ============================================================================
// Authentication
// ============================================================================

export interface AcpAuthenticateParams {
  credentials?: Record<string, unknown>;
}

export interface AcpAuthenticateResult {
  success: boolean;
  error?: string;
}

// ============================================================================
// Session
// ============================================================================

export interface AcpSessionNewParams {
  cwd: string;
  mcpServers?: AcpMcpServerConfig[];
}

export interface AcpSessionNewResult {
  sessionId: string;
  modes: AcpSessionMode[];
  configOptions: AcpConfigOption[];
}

export interface AcpSessionPromptParams {
  content: AcpContentBlock[];
}

export interface AcpSessionPromptResult {
  stopReason: 'end_turn' | 'tool_use' | 'error' | string;
}

export interface AcpSessionCancelParams {
  sessionId: string;
}

// ============================================================================
// Content Blocks
// ============================================================================

export type AcpContentBlock =
  | AcpTextContentBlock
  | AcpImageContentBlock
  | AcpAudioContentBlock
  | AcpResourceContentBlock
  | AcpResourceLinkContentBlock;

export interface AcpTextContentBlock {
  type: 'text';
  text: string;
}

export interface AcpImageContentBlock {
  type: 'image';
  source: {
    type: 'base64' | 'url';
    media_type: string;
    data: string;
  };
}

export interface AcpAudioContentBlock {
  type: 'audio';
  source: {
    type: 'base64' | 'url';
    media_type: string;
    data: string;
  };
}

export interface AcpResourceContentBlock {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
  };
}

export interface AcpResourceLinkContentBlock {
  type: 'resource_link';
  resourceLink: {
    uri: string;
    mimeType?: string;
    title?: string;
  };
}

// ============================================================================
// Session Update Notifications
// ============================================================================

export type AcpUpdateNotification =
  | AcpAgentMessageChunkUpdate
  | AcpAgentThoughtChunkUpdate
  | AcpToolCallUpdateNotification
  | AcpToolCallUpdateUpdate
  | AcpPlanUpdate
  | AcpCurrentModeUpdate
  | AcpConfigOptionUpdate
  | AcpSessionInfoUpdate;

export interface AcpAgentMessageChunkUpdate {
  type: 'session/update';
  update: {
    type: 'agent_message_chunk';
    chunk: AcpContentBlock;
  };
}

export interface AcpAgentThoughtChunkUpdate {
  type: 'session/update';
  update: {
    type: 'agent_thought_chunk';
    chunk: AcpContentBlock;
  };
}

export interface AcpToolCallUpdateNotification {
  type: 'session/update';
  update: {
    type: 'tool_call';
    tool_call: AcpToolCall;
  };
}

export interface AcpToolCallUpdateUpdate {
  type: 'session/update';
  update: {
    type: 'tool_call_update';
    tool_call_update: AcpToolCallUpdate;
  };
}

export interface AcpPlanUpdate {
  type: 'session/update';
  update: {
    type: 'plan';
    plan: string;
  };
}

export interface AcpCurrentModeUpdate {
  type: 'session/update';
  update: {
    type: 'current_mode_update';
    mode: AcpMode;
  };
}

export interface AcpConfigOptionUpdate {
  type: 'session/update';
  update: {
    type: 'config_option_update';
    configOption: AcpConfigOption;
    value: unknown;
  };
}

export interface AcpSessionInfoUpdate {
  type: 'session/update';
  update: {
    type: 'session_info_update';
    info: Record<string, unknown>;
  };
}

// ============================================================================
// Tool Calls
// ============================================================================

export interface AcpToolCall {
  id: string;
  kind: AcpToolKind;
  name: string;
  input: Record<string, unknown>;
  status: AcpToolCallStatus;
}

export interface AcpToolCallUpdate {
  id: string;
  status: AcpToolCallStatus;
  output?: unknown;
  error?: string;
}

export type AcpToolKind = 'mcp' | 'native' | 'custom';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

// ============================================================================
// Permissions
// ============================================================================

export interface AcpPermissionRequest {
  id: string;
  type: string;
  resource: string;
  action: string;
  options: AcpPermissionOption[];
}

export interface AcpPermissionResponse {
  id: string;
  granted: boolean;
  option?: string;
}

export interface AcpPermissionOption {
  label: string;
  value: string;
  description?: string;
}

// ============================================================================
// File System
// ============================================================================

export interface AcpFsReadParams {
  path: string;
  offset?: number;
  limit?: number;
}

export interface AcpFsReadResult {
  content: string;
  mimeType?: string;
}

export interface AcpFsWriteParams {
  path: string;
  content: string;
}

export interface AcpFsWriteResult {
  success: boolean;
  error?: string;
}

// ============================================================================
// Terminal
// ============================================================================

export interface AcpTerminalCreateParams {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface AcpTerminalCreateResult {
  terminalId: string;
  pid: number;
}

export interface AcpTerminalOutputParams {
  terminalId: string;
}

export interface AcpTerminalOutputResult {
  output: string;
  done: boolean;
  exitCode?: number;
}

export interface AcpTerminalWaitForExitParams {
  terminalId: string;
  timeoutMs?: number;
}

export interface AcpTerminalWaitForExitResult {
  exitCode: number;
  output: string;
}

export interface AcpTerminalKillParams {
  terminalId: string;
  signal?: string;
}

export interface AcpTerminalKillResult {
  success: boolean;
}

export interface AcpTerminalReleaseParams {
  terminalId: string;
}

export interface AcpTerminalReleaseResult {
  success: boolean;
}

// ============================================================================
// Config Options
// ============================================================================

export interface AcpConfigOption {
  id: string;
  label: string;
  category: 'model' | 'thought_level' | 'other';
  type: 'string' | 'number' | 'boolean' | 'enum';
  options?: string[];
  defaultValue?: unknown;
  description?: string;
}

// ============================================================================
// MCP Server Config
// ============================================================================

export type AcpMcpServerConfig =
  | AcpMcpStdioServerConfig
  | AcpMcpHttpServerConfig
  | AcpMcpSseServerConfig;

export interface AcpMcpStdioServerConfig {
  type: 'stdio';
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface AcpMcpHttpServerConfig {
  type: 'http';
  name?: string;
  url: string;
  headers?: Record<string, string>;
}

export interface AcpMcpSseServerConfig {
  type: 'sse';
  name?: string;
  url: string;
  headers?: Record<string, string>;
}

// ============================================================================
// Modes
// ============================================================================

export interface AcpMode {
  id: string;
  name: string;
  description?: string;
}

export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string;
}
