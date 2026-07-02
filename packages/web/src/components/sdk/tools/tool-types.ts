/**
 * Type definitions for tool rendering system
 */

import type { JSX } from 'preact';
import type { SDKTaskProgressMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

/**
 * Display variant for tool components
 */
export type ToolCardVariant =
  | 'compact' // Minimal, single line (best for mobile)
  | 'default' // Standard display
  | 'detailed' // Full information with all metadata
  | 'inline'; // Inline with text flow

/**
 * Size variants for tool icons
 */
export type ToolIconSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';

/**
 * Tool category for grouping and styling
 */
export type ToolCategory =
  | 'file' // File operations (Read, Write, Edit, NotebookEdit)
  | 'search' // Search operations (Glob, Grep)
  | 'terminal' // Terminal operations (Bash, BashOutput, KillShell)
  | 'agent' // Agent/Task operations
  | 'web' // Web operations (WebFetch, WebSearch)
  | 'todo' // Todo operations
  | 'mcp' // MCP operations
  | 'system' // System operations (ExitPlanMode, TimeMachine)
  | 'unknown'; // Unknown tool type

/**
 * Tool metadata configuration
 */
export interface ToolConfig {
  /** Display name for the tool */
  displayName?: string;

  /** Tool category for styling and grouping */
  category: ToolCategory;

  /** Custom icon component (optional) */
  icon?: () => JSX.Element;

  /** Custom summary extractor function */
  summaryExtractor?: (input: unknown) => string | null;

  /** Custom full renderer component (optional) */
  customRenderer?: (props: ToolRendererProps) => JSX.Element | null;

  /** Color theme override */
  colors?: {
    bg: string;
    text: string;
    border: string;
    iconColor: string;
    lightText?: string;
  };

  /** Whether this tool typically has long output */
  hasLongOutput?: boolean;

  /** Default expanded state for result cards */
  defaultExpanded?: boolean;
}

/**
 * Props for custom tool renderers
 */
export interface ToolRendererProps {
  toolName: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  variant?: ToolCardVariant;
}

/**
 * Tool icon props
 */
export interface ToolIconProps {
  toolName: string;
  size?: ToolIconSize;
  className?: string;
  animated?: boolean;
  category?: ToolCategory;
}

/**
 * Tool summary props
 */
export interface ToolSummaryProps {
  toolName: string;
  input: unknown;
  maxLength?: number;
  showTooltip?: boolean;
  className?: string;
}

/**
 * Tool progress card props
 */
export interface ToolProgressCardProps {
  toolName: string;
  toolInput?: unknown;
  elapsedTime: number;
  toolUseId: string;
  parentToolUseId?: string;
  variant?: ToolCardVariant;
  className?: string;
}

/**
 * Tool result card props
 */
export interface ToolResultCardProps {
  toolName: string;
  toolId: string;
  input: unknown;
  output?: unknown;
  isError?: boolean;
  variant?: ToolCardVariant;
  defaultExpanded?: boolean;
  className?: string;
  /** The message UUID (for deletion) */
  messageUuid?: string;
  /** The session ID (for deletion) */
  sessionId?: string;
  /** Whether the output was removed from SDK session file */
  isOutputRemoved?: boolean;
  /** Disable expand/collapse and hide the chevron icon */
  disableExpand?: boolean;
  /** When true, wrap this card in <RunningBorder> so the animated arc traces
   * this card's outer rounded-rectangle border. */
  isRunning?: boolean;
  /** Terminal task_notification for this tool_use (status/summary/usage).
   * Folded onto the card instead of rendered as a standalone system row. */
  taskNotification?: {
    status: 'completed' | 'failed' | 'stopped';
    summary?: string;
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  };
  /** Latest live task_progress for this running tool_use. */
  taskProgress?: SDKTaskProgressMessage;
}

/**
 * Auth status card props
 */
export interface AuthStatusCardProps {
  isAuthenticating: boolean;
  output?: string[];
  error?: string;
  variant?: ToolCardVariant;
  className?: string;
}
