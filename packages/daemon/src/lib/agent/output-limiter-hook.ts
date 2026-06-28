/**
 * Output Limiter Hook
 *
 * Prevents large tool outputs from overflowing the model context window.
 *
 * Strategy:
 * - PreToolUse: inject limit parameters for Read (line limit) and Grep
 *   (head_limit) so the tools fetch less data in the first place.
 * - PostToolUse: truncate Bash stdout/stderr via updatedToolOutput if the
 *   output exceeds line or byte thresholds. The command runs unwrapped,
 *   so exit codes, heredocs, cwd, sandbox, and background behavior are
 *   all preserved naturally.
 */

import type {
  HookCallback,
  PostToolUseHookInput,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';

// Resolved configuration (all fields populated)
interface OutputLimiterConfig {
  enabled: boolean;
  bash: {
    headLines: number;
    tailLines: number;
  };
  read: {
    maxLines: number;
  };
  grep: {
    maxMatches: number;
  };
  excludeTools: string[];
}

// Input shape: nested values may be partial (settings update path)
export interface OutputLimiterConfigInput {
  enabled?: boolean;
  bash?: {
    headLines?: number;
    tailLines?: number;
  };
  read?: {
    maxLines?: number;
    /** @deprecated Use maxLines instead. Legacy char-based limit. */
    maxChars?: number;
  };
  grep?: {
    maxMatches?: number;
  };
  excludeTools?: string[];
}

const DEFAULT_CONFIG: OutputLimiterConfig = {
  enabled: true,
  bash: {
    headLines: 100,
    tailLines: 200,
  },
  read: {
    maxLines: 1000,
  },
  grep: {
    // Match the SDK's built-in default so injecting head_limit never expands
    // output beyond what the SDK would have returned on its own.
    maxMatches: 250,
  },
  excludeTools: [],
};

export function resolveConfig(input: OutputLimiterConfigInput = {}): OutputLimiterConfig {
  return {
    enabled: input.enabled ?? DEFAULT_CONFIG.enabled,
    bash: {
      headLines: input.bash?.headLines ?? DEFAULT_CONFIG.bash.headLines,
      tailLines: input.bash?.tailLines ?? DEFAULT_CONFIG.bash.tailLines,
    },
    read: {
      maxLines:
        input.read?.maxLines ??
        (input.read?.maxChars !== undefined
          ? Math.floor(input.read.maxChars / 50)
          : DEFAULT_CONFIG.read.maxLines),
    },
    grep: {
      maxMatches: input.grep?.maxMatches ?? DEFAULT_CONFIG.grep.maxMatches,
    },
    excludeTools: input.excludeTools ?? DEFAULT_CONFIG.excludeTools,
  };
}

// ---------------------------------------------------------------------------
// PreToolUse hook: inject limit parameters for Read and Grep
// ---------------------------------------------------------------------------

export function createOutputLimiterPreHook(config: OutputLimiterConfigInput = {}): HookCallback {
  const finalConfig = resolveConfig(config);

  return async (input) => {
    if (!finalConfig.enabled) return {};
    if (input.hook_event_name !== 'PreToolUse') return {};

    const preInput = input as PreToolUseHookInput;
    const { tool_name, tool_input } = preInput;

    if (finalConfig.excludeTools.includes(tool_name)) return {};

    const modifiedInput = injectReadOrGrepLimit(tool_name, tool_input, finalConfig);
    if (!modifiedInput) return {};

    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        permissionDecision: 'allow' as const,
        updatedInput: modifiedInput,
      },
    };
  };
}

function injectReadOrGrepLimit(
  toolName: string,
  toolInput: unknown,
  config: OutputLimiterConfig
): Record<string, unknown> | null {
  const input = toolInput as Record<string, unknown>;

  switch (toolName) {
    case 'Read': {
      const maxLines = config.read.maxLines;
      if (typeof input.limit === 'number' && input.limit > 0 && input.limit <= maxLines) {
        return null;
      }
      return { ...input, limit: maxLines };
    }

    case 'Grep': {
      const maxMatches = config.grep.maxMatches;
      if (
        typeof input.head_limit === 'number' &&
        input.head_limit > 0 &&
        input.head_limit <= maxMatches
      ) {
        return null;
      }
      return { ...input, head_limit: maxMatches };
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// PostToolUse hook: truncate large Bash output via updatedToolOutput
// ---------------------------------------------------------------------------

export function createOutputLimiterPostHook(config: OutputLimiterConfigInput = {}): HookCallback {
  const finalConfig = resolveConfig(config);

  return async (input) => {
    if (!finalConfig.enabled) return {};
    if (input.hook_event_name !== 'PostToolUse') return {};

    const postInput = input as PostToolUseHookInput;
    const { tool_name, tool_response } = postInput;

    if (tool_name !== 'Bash') return {};
    if (finalConfig.excludeTools.includes(tool_name)) return {};

    const response = tool_response as { stdout?: string; stderr?: string } | null;
    if (!response || typeof response !== 'object') return {};

    const stdout = typeof response.stdout === 'string' ? response.stdout : '';
    const stderr = typeof response.stderr === 'string' ? response.stderr : '';

    const headLines = finalConfig.bash.headLines;
    const tailLines = finalConfig.bash.tailLines;
    const maxBytes = (headLines + tailLines) * 200;

    const totalLines = stdout.split('\n').length + stderr.split('\n').length;
    const totalBytes = stdout.length + stderr.length;

    if (totalLines <= headLines + tailLines && totalBytes <= maxBytes) {
      return {}; // Within limits
    }

    // Split the line budget across stdout and stderr proportionally so the
    // combined output stays within the configured cap.
    const stdoutTruncated = truncateOutput(stdout, headLines, tailLines, maxBytes);
    const stderrTruncated = truncateOutput(stderr, headLines, tailLines, maxBytes);

    const truncated: Record<string, unknown> = { ...response };
    truncated.stdout = stdoutTruncated;
    truncated.stderr = stderrTruncated;

    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        updatedToolOutput: truncated,
      },
    };
  };
}

/**
 * Truncate a string to the first `headLines` + last `tailLines` lines.
 * Also enforces a byte cap for strings with very long individual lines.
 * Returns the original string if within both limits.
 */
function truncateOutput(
  str: string,
  headLines: number,
  tailLines: number,
  maxBytes: number
): string {
  if (!str) return str;

  // Byte cap for very long single lines (minified JSON, base64).
  if (str.length > maxBytes) {
    const halfBytes = Math.floor(maxBytes / 2);
    return `${str.slice(0, halfBytes)}\n\n... [Truncated ${str.length - maxBytes} bytes] ...\n\n${str.slice(-halfBytes)}`;
  }

  const lines = str.split('\n');
  const threshold = headLines + tailLines;
  if (lines.length <= threshold) return str;

  const head = lines.slice(0, headLines).join('\n');
  const tail = tailLines > 0 ? lines.slice(-tailLines).join('\n') : '';
  const omitted = lines.length - headLines - tailLines;

  return tail
    ? `${head}\n\n... [Truncated ${omitted} lines — showing first ${headLines} and last ${tailLines} lines] ...\n\n${tail}`
    : `${head}\n\n... [Truncated ${omitted} lines — showing first ${headLines} lines] ...`;
}
