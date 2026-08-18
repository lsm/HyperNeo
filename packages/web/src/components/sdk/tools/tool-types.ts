import type { JSX } from 'preact';
import type { SDKTaskProgressMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

export type ToolCardVariant = 'compact' | 'default' | 'detailed' | 'inline';

export type ToolIconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

export type ToolCategory =
  | 'file'
  | 'search'
  | 'terminal'
  | 'agent'
  | 'web'
  | 'todo'
  | 'mcp'
  | 'system'
  | 'unknown';

export interface ToolConfig {
  displayName?: string;

  category: ToolCategory;

  icon?: () => JSX.Element;

  summaryExtractor?: (input: unknown) => string | null;

  customRenderer?: (props: ToolRendererProps) => JSX.Element | null;

  colors?: {
    bg: string;
    text: string;
    border: string;
    iconColor: string;
    lightText?: string;
  };

  hasLongOutput?: boolean;

  defaultExpanded?: boolean;
}

export interface ToolRendererProps {
  toolName: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  variant?: ToolCardVariant;
}

export interface ToolIconProps {
  toolName: string;
  size?: ToolIconSize;
  className?: string;
  animated?: boolean;
  category?: ToolCategory;
}

export interface ToolSummaryProps {
  toolName: string;
  input: unknown;
  maxLength?: number;
  showTooltip?: boolean;
  className?: string;
}

export interface ToolProgressCardProps {
  toolName: string;
  toolInput?: unknown;
  elapsedTime: number;
  toolUseId: string;
  parentToolUseId?: string;
  variant?: ToolCardVariant;
  className?: string;
}

export interface ToolResultCardProps {
  toolName: string;
  toolId: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  variant?: ToolCardVariant;
  defaultExpanded?: boolean;
  className?: string;
  messageUuid?: string;
  sessionId?: string;
  isOutputRemoved?: boolean;
  disableExpand?: boolean;
  isRunning?: boolean;
  taskNotification?: {
    status: 'completed' | 'failed' | 'stopped';
    summary?: string;
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  };
  taskProgress?: SDKTaskProgressMessage;
}

export interface AuthStatusCardProps {
  isAuthenticating: boolean;
  output?: string[];
  error?: string;
  variant?: ToolCardVariant;
  className?: string;
}
