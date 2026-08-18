export interface AcpJsonRpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: T;
}

interface AcpJsonRpcResponseBase {
  jsonrpc: '2.0';
  id: number | string | null;
}

export type AcpJsonRpcResponse<T = unknown> =
  | ({ result: T } & AcpJsonRpcResponseBase)
  | ({ error: AcpJsonRpcError } & AcpJsonRpcResponseBase);

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

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities?: AcpClientCapabilities;
  clientInfo?: {
    name: string;
    version: string;
  } | null;
  _meta?: object | null;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: AcpAgentCapabilities;
  agentInfo: {
    name: string;
    version: string;
  } | null;
  authMethods?: AcpAuthMethod[];
  _meta?: object | null;
}

export interface AcpClientCapabilities {
  fs?: { readTextFile: boolean; writeTextFile: boolean };
  terminal?: boolean;
  experimental?: Record<string, unknown>;
}

export interface AcpAgentCapabilities {
  auth?: { logout?: {} | null };
  loadSession?: boolean;
  mcpCapabilities?: { http: boolean; sse: boolean };
  promptCapabilities?: { audio: boolean; embeddedContext: boolean; image: boolean };
  sessionCapabilities?: {
    close?: {} | null;
    delete?: {} | null;
    list?: {} | null;
    resume?: {} | null;
    additionalDirectories?: {} | null;
  };
  experimental?: Record<string, unknown>;
}

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

export interface AcpSessionNewParams {
  cwd: string;
  mcpServers: AcpMcpServerConfig[];
  additionalDirectories?: string[];
  _meta?: object | null;
}

export interface AcpSessionNewResult {
  sessionId: string;
  modes?: AcpSessionModeState | null;
  configOptions?: AcpConfigOption[] | null;
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

export interface AcpSessionCloseResult {
  _meta?: object | null;
}

export interface AcpSessionDeleteParams {
  sessionId: string;
  _meta?: object | null;
}

export interface AcpSessionDeleteResult {
  _meta?: object | null;
}

export interface AcpSessionLoadParams {
  sessionId: string;
  cwd: string;
  mcpServers: AcpMcpServerConfig[];
  additionalDirectories?: string[];
  _meta?: object | null;
}

export interface AcpSessionLoadResult {
  sessionId?: string;
  modes?: AcpSessionModeState | null;
  configOptions?: AcpConfigOption[] | null;
  _meta?: object | null;
}

export interface AcpSessionResumeParams {
  sessionId: string;
  cwd: string;
  mcpServers?: AcpMcpServerConfig[];
  additionalDirectories?: string[];
  _meta?: object | null;
}

export interface AcpSessionResumeResult {
  sessionId?: string;
  modes?: AcpSessionModeState | null;
  configOptions?: AcpConfigOption[] | null;
  _meta?: object | null;
}

export interface AcpSessionListParams {
  cwd?: string | null;
  cursor?: string | null;
  _meta?: object | null;
}

export interface AcpSessionListResult {
  sessions: Array<{
    sessionId: string;
    cwd: string;
    title?: string | null;
    updatedAt?: string | null;
    additionalDirectories?: string[];
  }>;
  nextCursor?: string | null;
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
  value: string;
  _meta?: object | null;
}

export interface AcpSessionSetConfigOptionResult {
  configOptions: AcpConfigOption[];
  _meta?: object | null;
}

export type AcpContentBlock =
  | AcpTextContentBlock
  | AcpImageContentBlock
  | AcpAudioContentBlock
  | AcpResourceContentBlock
  | AcpResourceLinkContentBlock;

export interface AcpTextContentBlock {
  type: 'text';
  text: string;
  annotations?: unknown;
  _meta?: object | null;
}

export interface AcpImageContentBlock {
  type: 'image';
  mimeType: string;
  data: string;
  uri?: string;
  annotations?: unknown;
  _meta?: object | null;
}

export interface AcpAudioContentBlock {
  type: 'audio';
  mimeType: string;
  data: string;
  annotations?: unknown;
  _meta?: object | null;
}

export interface AcpResourceContentBlockBase {
  type: 'resource';
  resource: {
    uri: string;
    mimeType?: string;
  };
  annotations?: unknown;
  _meta?: object | null;
}

export interface AcpResourceTextContentBlock extends AcpResourceContentBlockBase {
  resource: {
    uri: string;
    mimeType?: string;
    text: string;
  };
}

export interface AcpResourceBlobContentBlock extends AcpResourceContentBlockBase {
  resource: {
    uri: string;
    mimeType?: string;
    blob: string;
  };
}

export type AcpResourceContentBlock = AcpResourceTextContentBlock | AcpResourceBlobContentBlock;

export interface AcpResourceLinkContentBlock {
  type: 'resource_link';
  uri: string;
  name: string;
  title?: string | null;
  mimeType?: string | null;
  description?: string | null;
  size?: number | null;
  annotations?: unknown;
  _meta?: object | null;
}

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
  | AcpUsageUpdate
  | AcpAvailableCommandsUpdate;

export interface AcpAgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: AcpContentBlock;
  messageId?: string | null;
}

export interface AcpUserMessageChunkUpdate {
  sessionUpdate: 'user_message_chunk';
  content: AcpContentBlock;
  messageId?: string | null;
}

export interface AcpAgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk';
  content: AcpContentBlock;
  messageId?: string | null;
}

export interface AcpToolCallUpdateNotification {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  kind?: AcpToolKind;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: AcpToolCallContent[];
  locations?: AcpToolCallLocation[];
  status?: AcpToolCallStatus;
}

export interface AcpToolCallUpdateUpdate {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  status?: AcpToolCallStatus | null;
  title?: string | null;
  kind?: AcpToolKind | null;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: AcpToolCallContent[] | null;
  locations?: AcpToolCallLocation[] | null;
}

export interface AcpPlanUpdate {
  sessionUpdate: 'plan';
  entries: AcpPlanEntry[];
}

export interface AcpPlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'high' | 'medium' | 'low';
}

export interface AcpCurrentModeUpdate {
  sessionUpdate: 'current_mode_update';
  currentModeId: string;
}

export interface AcpConfigOptionUpdate {
  sessionUpdate: 'config_option_update';
  configOptions: AcpConfigOption[];
}

export interface AcpSessionInfoUpdate {
  sessionUpdate: 'session_info_update';
  title?: string | null;
  updatedAt?: string | null;
}

export interface AcpUsageUpdate {
  sessionUpdate: 'usage_update';
  size: number;
  used: number;
  cost?: {
    amount: number;
    currency: string;
  } | null;
}

export interface AcpAvailableCommandsUpdate {
  sessionUpdate: 'available_commands_update';
  availableCommands: AcpAvailableCommand[];
}

export interface AcpAvailableCommand {
  name: string;
  description: string;
  input?: {
    hint: string;
  } | null;
}

export interface AcpToolCall {
  toolCallId: string;
  kind?: AcpToolKind;
  title: string;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: AcpToolCallContent[];
  locations?: AcpToolCallLocation[];
  status: AcpToolCallStatus;
}

export interface AcpToolCallUpdate {
  toolCallId: string;
  status?: AcpToolCallStatus;
  title?: string;
  kind?: AcpToolKind;
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: AcpToolCallContent[];
  locations?: AcpToolCallLocation[];
}

export type AcpToolCallContent =
  | AcpToolCallContentWrapper
  | AcpToolCallDiffContent
  | AcpToolCallTerminalContent;

export interface AcpToolCallContentWrapper {
  type: 'content';
  content: AcpContentBlock;
}

export interface AcpToolCallDiffContent {
  type: 'diff';
  path: string;
  oldText: string | null;
  newText: string;
}

export interface AcpToolCallTerminalContent {
  type: 'terminal';
  terminalId: string;
}

export interface AcpToolCallLocation {
  path: string;
  line?: number;
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

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
  _meta?: object | null;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export type AcpPermissionResponseResult = {
  outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' };
};

export interface AcpFsReadParams {
  sessionId: string;
  path: string;
  line?: number | null;
  limit?: number | null;
  _meta?: object | null;
}

export interface AcpFsReadResult {
  content: string;
  _meta?: object | null;
}

export interface AcpFsWriteParams {
  sessionId: string;
  path: string;
  content: string;
  _meta?: object | null;
}

export interface AcpFsWriteResult {
  _meta?: object | null;
}

export interface AcpTerminalCreateParams {
  sessionId: string;
  command: string;
  args?: string[];
  cwd?: string | null;
  env?: AcpEnvVariable[];
  outputByteLimit?: number | null;
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
  exitStatus?: { exitCode: number | null; signal?: string | null } | null;
  _meta?: object | null;
}

export interface AcpTerminalWaitForExitParams {
  sessionId: string;
  terminalId: string;
  _meta?: object | null;
}

export interface AcpTerminalWaitForExitResult {
  exitCode: number | null;
  signal?: string | null;
  _meta?: object | null;
}

export interface AcpTerminalKillParams {
  sessionId: string;
  terminalId: string;
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

export interface AcpConfigOption {
  id: string;
  name: string;
  type: 'select';
  options: AcpConfigOptionChoice[] | AcpConfigOptionGroup[];
  currentValue: string;
  category?: string;
  defaultValue?: unknown;
  description?: string;
  _meta?: object | null;
}

export interface AcpConfigOptionChoice {
  name: string;
  value: string;
}

export interface AcpConfigOptionGroup {
  group: string;
  name: string;
  options: AcpConfigOptionChoice[];
}

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
  env: AcpEnvVariable[];
}

export interface AcpHeader {
  name: string;
  value: string;
}

export interface AcpMcpHttpServerConfig {
  type: 'http';
  name: string;
  url: string;
  headers: AcpHeader[];
}

export interface AcpMcpSseServerConfig {
  type: 'sse';
  name: string;
  url: string;
  headers: AcpHeader[];
}

export interface AcpSessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface AcpLogoutParams {
  _meta?: object | null;
}

export interface AcpLogoutResult {
  _meta?: object | null;
}
