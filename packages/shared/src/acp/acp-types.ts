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
  authMethods?: AcpAuthMethod[];
  _meta?: object | null;
}

export interface AcpClientCapabilities {
  fs?: boolean;
  terminal?: boolean;
  experimental?: Record<string, unknown>;
}

export interface AcpAgentCapabilities {
  streaming?: boolean;
  thinking?: boolean;
  fs?: boolean;
  terminal?: boolean;
  experimental?: Record<string, unknown>;
}

// ============================================================================
// Authentication
// ============================================================================

export interface AcpAuthMethod {
  id: string;
  name: string;
  description?: string;
}

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
  mcpServers: AcpMcpServerConfig[];
  additionalDirectories?: string[];
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
  cwd: string;
  mcpServers: AcpMcpServerConfig[];
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
  configId: string;
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
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
  size?: number;
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
  | AcpUserMessageChunkUpdate
  | AcpAgentThoughtChunkUpdate
  | AcpToolCallUpdateNotification
  | AcpToolCallUpdateUpdate
  | AcpPlanUpdate
  | AcpCurrentModeUpdate
  | AcpConfigOptionUpdate
  | AcpSessionInfoUpdate
  | AcpAvailableCommandsUpdate;

export interface AcpAgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: AcpContentBlock;
  messageId?: string;
}

export interface AcpUserMessageChunkUpdate {
  sessionUpdate: 'user_message_chunk';
  content: AcpContentBlock;
  messageId?: string;
}

export interface AcpAgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk';
  content: AcpContentBlock;
  messageId?: string;
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
  entries?: AcpPlanEntry[];
}

export interface AcpPlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'done' | 'error';
  priority?: number;
}

export interface AcpCurrentModeUpdate {
  sessionUpdate: 'current_mode_update';
  currentModeId: string;
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

export interface AcpAvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update';
  commands: AcpAvailableCommand[];
}

export interface AcpAvailableCommand {
  name: string;
  description: string;
}

// ============================================================================
// Tool Calls
// ============================================================================

export interface AcpToolCall {
  toolCallId: string;
  kind: AcpToolKind;
  title: string;
  rawInput: Record<string, unknown>;
  rawOutput?: unknown;
  content?: AcpContentBlock[];
  locations?: string[];
  status: AcpToolCallStatus;
}

export interface AcpToolCallUpdate {
  toolCallId: string;
  status: AcpToolCallStatus;
  output?: unknown;
  error?: string;
}

export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

// ============================================================================
// Permissions
// ============================================================================

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: AcpToolCall;
  options: AcpPermissionOption[];
  _meta?: object | null;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export type AcpPermissionResponse =
  | {
      id: string;
      outcome: 'selected';
      optionId: string;
      _meta?: object | null;
    }
  | {
      id: string;
      outcome: 'cancelled';
      _meta?: object | null;
    };

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
  env?: AcpEnvVariable[];
  outputByteLimit?: number;
  _meta?: object | null;
}

export interface AcpTerminalCreateResult {
  terminalId: string;
  _meta?: object | null;
}

export interface AcpTerminalOutputParams {
  sessionId: string;
  terminalId: string;
  _meta?: object | null;
}

export interface AcpTerminalOutputResult {
  output: string;
  truncated: boolean;
  exitStatus?: number;
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
  signal?: string;
  _meta?: object | null;
}

export interface AcpTerminalKillParams {
  sessionId: string;
  terminalId: string;
  signal?: string;
  _meta?: object | null;
}

export interface AcpTerminalKillResult {
  _meta?: object | null;
}

export interface AcpTerminalReleaseParams {
  sessionId: string;
  terminalId: string;
  _meta?: object | null;
}

export interface AcpTerminalReleaseResult {
  _meta?: object | null;
}

// ============================================================================
// Config Options
// ============================================================================

export interface AcpConfigOption {
  id: string;
  label: string;
  type: 'select';
  options: AcpConfigOptionChoice[];
  currentValue: string;
  defaultValue?: unknown;
  description?: string;
  _meta?: object | null;
}

export interface AcpConfigOptionChoice {
  label: string;
  value: string;
}

// ============================================================================
// MCP Server Config
// ============================================================================

export type AcpMcpServerConfig =
  | AcpMcpStdioServerConfig
  | AcpMcpHttpServerConfig
  | AcpMcpSseServerConfig;

export interface AcpEnvVariable {
  name: string;
  value: string;
}

export interface AcpMcpStdioServerConfig {
  type: 'stdio';
  name: string;
  command: string;
  args: string[];
  env?: AcpEnvVariable[];
}

export interface AcpMcpHttpServerConfig {
  type: 'http';
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export interface AcpMcpSseServerConfig {
  type: 'sse';
  name: string;
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
