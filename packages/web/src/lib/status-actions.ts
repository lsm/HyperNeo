/**
 * Status Actions Utility
 *
 * Extracts meaningful action verbs from SDK messages for the status indicator
 * Maps tool names and SDK events to human-readable action phrases
 *
 * Priority order (in getCurrentAction):
 * 1. Compaction status (highest priority)
 * 2. Tool-specific actions from latest message:
 *    a. SDKToolProgressMessage (actively running tools) - BEST for persistence
 *    b. Assistant messages with tool_use blocks
 *    c. Stream events with tool_use content blocks
 * 3. Phase-based actions (initializing/thinking/streaming/finalizing)
 * 4. Fallback rotating actions
 *
 * Key: SDKToolProgressMessage is emitted while tools are running, providing persistent
 * status instead of brief flashes when tool_use blocks appear in assistant messages.
 */

import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

/**
 * Streaming phase types
 */
export type StreamingPhase = 'initializing' | 'thinking' | 'streaming' | 'finalizing';

// Fallback actions when we can't determine specific tool/action
const FALLBACK_ACTIONS = [
  'Thinking...',
  'Processing...',
  'Working...',
  'Analyzing...',
  'Considering...',
  'Computing...',
];

// Map tool names to action verbs (Claude Code style)
const TOOL_ACTION_MAP: Record<string, string> = {
  Read: 'Reading files...',
  Write: 'Writing files...',
  Edit: 'Editing files...',
  Bash: 'Running command...',
  Grep: 'Searching code...',
  Glob: 'Finding files...',
  Task: 'Starting agent...',
  Agent: 'Starting agent...',
  WebFetch: 'Fetching web content...',
  WebSearch: 'Searching web...',
  SlashCommand: 'Running command...',
  NotebookEdit: 'Editing notebook...',
  // MCP tools
  mcp__chrome_devtools__take_snapshot: 'Taking snapshot...',
  mcp__chrome_devtools__click: 'Clicking element...',
  mcp__chrome_devtools__fill: 'Filling form...',
  mcp__chrome_devtools__navigate_page: 'Navigating page...',
  mcp__shadcn__search_items_in_registries: 'Searching components...',
  mcp__shadcn__view_items_in_registries: 'Viewing components...',
};

// Track last used fallback index to rotate through them
let lastFallbackIndex = -1;

/**
 * Get next random fallback action (rotates through list)
 */
function getNextFallbackAction(): string {
  lastFallbackIndex = (lastFallbackIndex + 1) % FALLBACK_ACTIONS.length;
  return FALLBACK_ACTIONS[lastFallbackIndex];
}

/**
 * Extract action from tool name
 */
function getActionFromToolName(toolName: string): string | null {
  // Check exact match first
  if (TOOL_ACTION_MAP[toolName]) {
    return TOOL_ACTION_MAP[toolName];
  }

  // Check if it starts with any known tool name (for MCP tools with prefixes)
  for (const [key, value] of Object.entries(TOOL_ACTION_MAP)) {
    if (toolName.includes(key)) {
      return value;
    }
  }

  // Try to extract readable name from MCP tools
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    if (parts.length >= 3) {
      // mcp__service__action -> "Action..."
      const action = parts[parts.length - 1]
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      return `${action}...`;
    }
  }

  return null;
}

/**
 * Extract action verb from SDK message
 * Returns null if no specific action can be determined
 * Internal-only: used by getCurrentAction()
 */
function extractActionFromMessage(message: SDKMessage): string | null {
  // PRIORITY 1: Tool progress messages (actively running tools)
  // These messages are emitted while a tool is executing, providing real-time status
  if (message.type === 'tool_progress') {
    const toolProgressMsg = message as {
      tool_name: string;
      elapsed_time_seconds: number;
    };
    const action = getActionFromToolName(toolProgressMsg.tool_name);
    if (action) {
      // Show elapsed time for long-running tools (>1s)
      const elapsed = Math.floor(toolProgressMsg.elapsed_time_seconds);
      if (elapsed > 1) {
        return action.replace('...', ` (${elapsed}s)...`);
      }
      return action;
    }
  }

  // PRIORITY 2: Assistant messages with tool use
  if (message.type === 'assistant' && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type === 'tool_use' && block.name) {
        const action = getActionFromToolName(block.name);
        if (action) return action;
      }
    }
  }

  // PRIORITY 3: Stream events
  if (message.type === 'stream_event') {
    const { event } = message;

    // Content block start - check if it's thinking
    if (event.type === 'content_block_start') {
      if (event.content_block?.type === 'thinking') {
        return 'Thinking...';
      }
      if (event.content_block?.type === 'tool_use' && event.content_block.name) {
        const action = getActionFromToolName(event.content_block.name);
        if (action) return action;
      }
    }

    // Content block delta - check if it's text
    if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') {
        return 'Writing...';
      }
    }
  }

  return null;
}

/**
 * Get phase-based action text
 * Returns action text for the given streaming phase with optional duration
 */
function getPhaseAction(phase: StreamingPhase, streamingStartedAt?: number): string {
  switch (phase) {
    case 'initializing':
      return 'Starting...';
    case 'thinking':
      return 'Thinking...';
    case 'streaming': {
      // Calculate streaming duration if available
      if (streamingStartedAt) {
        const duration = Math.floor((Date.now() - streamingStartedAt) / 1000);
        return duration > 0 ? `Streaming (${duration}s)...` : 'Streaming...';
      }
      return 'Streaming...';
    }
    case 'finalizing':
      return 'Finalizing...';
  }
}

/**
 * Get current action for status indicator
 *
 * Priority order:
 * 1. Compaction status (if isCompacting is true)
 * 2. Tool-specific actions from latest message
 * 3. Phase-based actions (initializing/thinking/streaming/finalizing)
 * 4. Fallback rotating actions
 *
 * @param latestMessage - Latest SDK message (for tool action extraction)
 * @param isProcessing - Whether agent is currently processing
 * @param options - Optional status context
 * @param options.isCompacting - Whether context is being compacted
 * @param options.streamingPhase - Current streaming phase
 * @param options.streamingStartedAt - Timestamp when streaming started (for duration)
 */
export function getCurrentAction(
  latestMessage: SDKMessage | null,
  isProcessing: boolean,
  options?: {
    isCompacting?: boolean;
    streamingPhase?: StreamingPhase;
    streamingStartedAt?: number;
  }
): string | undefined {
  if (!isProcessing) {
    return undefined;
  }

  // Priority 1: Compaction takes highest priority
  if (options?.isCompacting) {
    return 'Compacting context...';
  }

  // Priority 2: Try to extract tool-specific action from latest message
  if (latestMessage) {
    const extracted = extractActionFromMessage(latestMessage);
    if (extracted) {
      return extracted;
    }
  }

  // Priority 3: Use phase-based action if available
  if (options?.streamingPhase) {
    return getPhaseAction(options.streamingPhase, options.streamingStartedAt);
  }

  // Priority 4: Fallback to rotating actions
  return getNextFallbackAction();
}
