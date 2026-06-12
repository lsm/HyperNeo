import type {
  McpServerConfig,
  McpSetServersResult,
  ModelInfo as SDKModelInfo,
  RewindFilesResult,
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SlashCommand,
} from '@neokai/shared/sdk';

export type QueryLike = AsyncIterable<SDKMessage> & {
  interrupt(): Promise<void>;
  close(): void;
  setMcpServers?(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult>;
  sessionId?: string;
  supportedCommands?(): Promise<SlashCommand[]>;
  supportedModels?(): Promise<SDKModelInfo[]>;
  getContextUsage?(): Promise<SDKControlGetContextUsageResponse>;
  setMaxThinkingTokens?(tokens: number | null): Promise<void>;
  setPermissionMode?(mode: string): Promise<void>;
  mcpServerStatus?(): Promise<unknown[]>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
};
