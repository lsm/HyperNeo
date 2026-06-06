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
  clientCapabilities: AcpClientCapabilities;
  clientInfo: {
    name: string;
    version: string;
  };
  _meta?: object | null;
}

export interface AcpInitializeResult {
  protocolVersion: string;
  agentCapabilities: AcpAgentCapabilities;
  agentInfo: {
    name: string;
    version: string;
  };
  authMethods?: string[];
  _meta?: object | null;
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
  methodId: string;
  _meta?: object | null;
}

export interface AcpAuthenticateResult {
  _meta?: object | null;
}

// ============================================================================
// Session
// ============================================================================

export interface AcpSessionNewParams {
  cwd: string;
  mcpServers?: AcpMcpServerConfig[];
  _meta?: object | null;
}

export interface AcpSessionNewResult {
  sessionId: string;
  modes?: AcpSessionModeState;
  configOptions?: AcpConfigOption[];
  _meta?: object | null;
}

export interface AcpSessionModeState {
  currentModeId: string;
  availableModes: AcpSessionMode[];
}

export interface AcpSessionPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
  _meta?: object | null;
}

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface AcpSessionPromptResult {
  stopReason: AcpStopReason;
  _meta?: object | null;
}

export interface AcpSessionCancelParams {
  sessionId: string;
  _meta?: object | null;
}

export interface AcpSessionCloseParams {
  sessionId: string;
  _meta?: object | null;
}

export interface AcpSessionLoadParams {
  sessionId: string;
  _meta?: object | null;
}

export interface AcpSessionLoadResult {
  sessionId: string;
  modes?: AcpSessionModeState;
  configOptions?: AcpConfigOption[];
  _meta?: object | null;
}

export interface AcpSessionResumeParams {
  sessionId: string;
  prompt: AcpContentBlock[];
  _meta?: object | null;
}

export interface AcpSessionResumeResult {
  stopReason: AcpStopReason;
  _meta?: object | null;
}

export interface AcpSessionListResult {
  sessions: Array<{
    sessionId: string;
    cwd: string;
  }>;
  _meta?: object | null;
}

export interface AcpSessionSetModeParams {
  sessionId: string;
  modeId: string;
  _meta?: object | null;
}

export interface AcpSessionSetConfigOptionParams {
  sessionId: string;
  configOptionId: string;
  value: unknown;
  _meta?: object | null;
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
  mimeType: string;
  data: string;
  uri?: string;
}

export interface AcpAudioContentBlock {
  type: 'audio';
  mimeType: string;
  data: string;
  uri?: string;
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

export interface AcpSessionUpdateNotification {
  sessionId: string;
  update: AcpSessionUpdate;
}

export type AcpSessionUpdate =
  | AcpAgentMessageChunkUpdate
  | AcpAgentThoughtChunkUpdate
  | AcpToolCallUpdateNotification
  | AcpToolCallUpdateUpdate
  | AcpPlanUpdate
  | AcpCurrentModeUpdate
  | AcpConfigOptionUpdate
  | AcpSessionInfoUpdate;

export interface AcpAgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: AcpContentBlock;
}

export interface AcpAgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk';
  content: AcpContentBlock;
}

export interface AcpToolCallUpdateNotification {
  sessionUpdate: 'tool_call';
  toolCall: AcpToolCall;
}

export interface AcpToolCallUpdateUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallUpdate: AcpToolCallUpdate;
}

export interface AcpPlanUpdate {
  sessionUpdate: 'plan';
  plan: string;
}

export interface AcpCurrentModeUpdate {
  sessionUpdate: 'current_mode_update';
  mode: AcpSessionMode;
}

export interface AcpConfigOptionUpdate {
  sessionUpdate: 'config_option_update';
  configOption: AcpConfigOption;
  value: unknown;
}

export interface AcpSessionInfoUpdate {
  sessionUpdate: 'session_info_update';
  info: Record<string, unknown>;
}

// ============================================================================
// Tool Calls
// ============================================================================

export interface AcpToolCall {
  toolCallId: string;
  kind: AcpToolKind;
  name: string;
  input: Record<string, unknown>;
  status: AcpToolCallStatus;
}

export interface AcpToolCallUpdate {
  toolCallId: string;
  status: AcpToolCallStatus;
  output?: unknown;
  error?: string;
}

export type AcpToolKind = 'read' | 'edit' | 'create' | 'delete' | 'run_command' | 'view' | 'custom';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

// ============================================================================
// Permissions
// ============================================================================

export interface AcpPermissionRequest {
  id: string;
  toolCall: AcpToolCall;
  _meta?: object | null;
}

export interface AcpPermissionResponse {
  id: string;
  outcome: 'allow' | 'deny' | 'allow_once';
  _meta?: object | null;
}

// ============================================================================
// File System
// ============================================================================

export interface AcpFsReadParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
  _meta?: object | null;
}

export interface AcpFsReadResult {
  content: string;
  mimeType?: string;
  _meta?: object | null;
}

export interface AcpFsWriteParams {
  sessionId: string;
  path: string;
  content: string;
  _meta?: object | null;
}

export interface AcpFsWriteResult {
  success: boolean;
  error?: string;
  _meta?: object | null;
}

// ============================================================================
// Terminal
// ============================================================================

export interface AcpTerminalCreateParams {
  sessionId: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  outputByteLimit?: number;
  _meta?: object | null;
}

export interface AcpTerminalCreateResult {
  terminalId: string;
  pid: number;
  _meta?: object | null;
}

export interface AcpTerminalOutputParams {
  sessionId: string;
  terminalId: string;
  _meta?: object | null;
}

export interface AcpTerminalOutputResult {
  output: string;
  done: boolean;
  exitCode?: number;
  _meta?: object | null;
}

export interface AcpTerminalWaitForExitParams {
  sessionId: string;
  terminalId: string;
  timeoutMs?: number;
  _meta?: object | null;
}

export interface AcpTerminalWaitForExitResult {
  exitCode: number;
  output: string;
  _meta?: object | null;
}

export interface AcpTerminalKillParams {
  sessionId: string;
  terminalId: string;
  signal?: string;
  _meta?: object | null;
}

export interface AcpTerminalKillResult {
  success: boolean;
  _meta?: object | null;
}

export interface AcpTerminalReleaseParams {
  sessionId: string;
  terminalId: string;
  _meta?: object | null;
}

export interface AcpTerminalReleaseResult {
  success: boolean;
  _meta?: object | null;
}

// ============================================================================
// Config Options
// ============================================================================

export interface AcpConfigOption {
  id: string;
  label: string;
  category: 'model' | 'thought_level' | 'other';
  type: 'select';
  options: AcpConfigOptionChoice[];
  defaultValue?: unknown;
  description?: string;
  _meta?: object | null;
}

export interface AcpConfigOptionChoice {
  label: string;
  value: string;
  group?: string;
}

// ============================================================================
// MCP Server Config
// ============================================================================

export type AcpMcpServerConfig =
  | AcpMcpStdioServerConfig
  | AcpMcpHttpServerConfig
  | AcpMcpSseServerConfig;

export interface AcpEnvVariable {
  key: string;
  value: string;
}

export interface AcpMcpStdioServerConfig {
  type: 'stdio';
  name?: string;
  command: string;
  args: string[];
  env?: AcpEnvVariable[];
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

export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string;
}

// ============================================================================
// Logout
// ============================================================================

export interface AcpLogoutParams {
  _meta?: object | null;
}

export interface AcpLogoutResult {
  _meta?: object | null;
}
