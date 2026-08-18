import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

export type StreamingPhase = 'initializing' | 'thinking' | 'streaming' | 'finalizing';

const FALLBACK_ACTIONS = [
  'Thinking...',
  'Processing...',
  'Working...',
  'Analyzing...',
  'Considering...',
  'Computing...',
];

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
  mcp__chrome_devtools__take_snapshot: 'Taking snapshot...',
  mcp__chrome_devtools__click: 'Clicking element...',
  mcp__chrome_devtools__fill: 'Filling form...',
  mcp__chrome_devtools__navigate_page: 'Navigating page...',
  mcp__shadcn__search_items_in_registries: 'Searching components...',
  mcp__shadcn__view_items_in_registries: 'Viewing components...',
};

let lastFallbackIndex = -1;

function getNextFallbackAction(): string {
  lastFallbackIndex = (lastFallbackIndex + 1) % FALLBACK_ACTIONS.length;
  return FALLBACK_ACTIONS[lastFallbackIndex];
}

function getActionFromToolName(toolName: string): string | null {
  if (TOOL_ACTION_MAP[toolName]) {
    return TOOL_ACTION_MAP[toolName];
  }

  for (const [key, value] of Object.entries(TOOL_ACTION_MAP)) {
    if (toolName.includes(key)) {
      return value;
    }
  }

  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    if (parts.length >= 3) {
      const action = parts[parts.length - 1]
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      return `${action}...`;
    }
  }

  return null;
}

function extractActionFromMessage(message: SDKMessage): string | null {
  if (message.type === 'tool_progress') {
    const toolProgressMsg = message as {
      tool_name: string;
      elapsed_time_seconds: number;
    };
    const action = getActionFromToolName(toolProgressMsg.tool_name);
    if (action) {
      const elapsed = Math.floor(toolProgressMsg.elapsed_time_seconds);
      if (elapsed > 1) {
        return action.replace('...', ` (${elapsed}s)...`);
      }
      return action;
    }
  }

  if (message.type === 'assistant' && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type === 'tool_use' && block.name) {
        const action = getActionFromToolName(block.name);
        if (action) return action;
      }
    }
  }

  if (message.type === 'stream_event') {
    const { event } = message;

    if (event.type === 'content_block_start') {
      if (event.content_block?.type === 'thinking') {
        return 'Thinking...';
      }
      if (event.content_block?.type === 'tool_use' && event.content_block.name) {
        const action = getActionFromToolName(event.content_block.name);
        if (action) return action;
      }
    }

    if (event.type === 'content_block_delta') {
      if (event.delta?.type === 'text_delta') {
        return 'Writing...';
      }
    }
  }

  return null;
}

function getPhaseAction(phase: StreamingPhase, streamingStartedAt?: number): string {
  switch (phase) {
    case 'initializing':
      return 'Starting...';
    case 'thinking':
      return 'Thinking...';
    case 'streaming': {
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

  if (options?.isCompacting) {
    return 'Compacting context...';
  }

  if (latestMessage) {
    const extracted = extractActionFromMessage(latestMessage);
    if (extracted) {
      return extracted;
    }
  }

  if (options?.streamingPhase) {
    return getPhaseAction(options.streamingPhase, options.streamingStartedAt);
  }

  return getNextFallbackAction();
}
