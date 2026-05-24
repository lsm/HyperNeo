/**
 * Output Limiter Hook (Experimental)
 *
 * Prevents large tool outputs by injecting output limiting parameters
 * before tools execute, avoiding "prompt too long" API errors.
 *
 * Strategy: Use PreToolUse hooks to modify tool inputs and add output limits.
 * This prevents large outputs from being generated in the first place.
 *
 * Note: PostToolUse hooks CANNOT modify tool_response - they can only add
 * additionalContext. Therefore, we must limit outputs at the input stage.
 */

import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import { Logger } from '../logger';

// Output limiter configuration
interface OutputLimiterConfig {
  enabled: boolean;
  bash: {
    headLines: number;
    tailLines: number;
  };
  read: {
    maxChars: number;
  };
  grep: {
    maxMatches: number;
  };
  glob: {
    maxFiles: number;
  };
  excludeTools: string[];
}

const DEFAULT_CONFIG: OutputLimiterConfig = {
  enabled: true,
  bash: {
    headLines: 100,
    tailLines: 200,
  },
  read: {
    maxChars: 50000,
  },
  grep: {
    maxMatches: 500,
  },
  glob: {
    maxFiles: 1000,
  },
  excludeTools: [],
};

/**
 * Creates a PreToolUse hook that injects output limiting parameters
 * into tool inputs to prevent excessively large outputs.
 *
 * @param config - Configuration for output limiting behavior
 * @returns Hook callback function
 *
 * @example
 * ```typescript
 * const hook = createOutputLimiterHook({
 *   enabled: true,
 *   limits: { BASH_MAX_LINES: 500 }
 * });
 *
 * const options = {
 *   hooks: {
 *     PreToolUse: [{ hooks: [hook] }]
 *   }
 * };
 * ```
 */
export function createOutputLimiterHook(config: Partial<OutputLimiterConfig> = {}): HookCallback {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const logger = new Logger('OutputLimiterHook');

  return async (input, _toolUseID, { signal: _signal }) => {
    if (!finalConfig.enabled) {
      return {};
    }

    // Only process PreToolUse events
    if (input.hook_event_name !== 'PreToolUse') {
      return {};
    }

    const preInput = input as PreToolUseHookInput;
    const { tool_name, tool_input } = preInput;

    // Skip excluded tools
    if (finalConfig.excludeTools.includes(tool_name)) {
      return {};
    }

    // Modify tool inputs based on tool type
    const modifiedInput = limitToolInput(tool_name, tool_input, finalConfig, logger);

    if (!modifiedInput) {
      // No changes needed
      return {};
    }

    // Return modified input with allow decision
    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
        permissionDecision: 'allow' as const,
        updatedInput: modifiedInput,
      },
    };
  };
}

/**
 * Inject output limiting parameters into tool inputs
 * Returns modified input if changes were made, null otherwise
 */
function limitToolInput(
  toolName: string,
  toolInput: unknown,
  config: OutputLimiterConfig,
  _logger: Logger
): Record<string, unknown> | null {
  const input = toolInput as Record<string, unknown>;

  switch (toolName) {
    case 'Bash': {
      // Smart output limiting: capture both start and end of output
      const command = input.command as string | undefined;
      if (!command) return null;

      // Skip if already has head/tail limiting
      if (/\|\s*(head|tail)/.test(command)) {
        return null;
      }

      // Skip simple commands that are unlikely to produce large output
      // (pwd, cd, echo simple strings, etc.)
      const simpleCommands = /^(pwd|cd|echo\s+"[^"]{0,50}"|ls(\s+-\w+)?(\s+\S+)?|which|whoami)$/;
      if (simpleCommands.test(command.trim())) {
        return null;
      }

      const headLines = config.bash.headLines;
      const tailLines = config.bash.tailLines;

      // Create smart truncation command:
      // 1. Save output to temp file
      // 2. If output exceeds limit: show first N + truncation message + last N
      // 3. Otherwise: show all output
      // 4. Clean up temp file
      const limitedCommand = `tmpfile=$(mktemp); (${command}) 2>&1 > "$tmpfile"; total_lines=$(wc -l < "$tmpfile"); if [ "$total_lines" -gt ${headLines + tailLines} ]; then head -n ${headLines} "$tmpfile"; echo ""; echo "... [Truncated $(($total_lines - ${headLines + tailLines})) lines - showing first ${headLines} and last ${tailLines} lines] ..."; echo ""; tail -n ${tailLines} "$tmpfile"; else cat "$tmpfile"; fi; rm -f "$tmpfile"`;

      return {
        ...input,
        command: limitedCommand,
        description: `${input.description || 'Execute command'} (output: first ${headLines} + last ${tailLines} lines)`,
      };
    }

    case 'Read': {
      // Inject limit parameter if not present
      if (typeof input.limit === 'number') {
        return null; // Already has limit
      }

      const maxChars = config.read.maxChars;

      return {
        ...input,
        // Convert char limit to line limit (assume ~50 chars per line)
        limit: Math.floor(maxChars / 50),
      };
    }

    case 'Grep': {
      // Inject head_limit parameter if not present
      if (typeof input.head_limit === 'number') {
        return null; // Already has limit
      }

      const maxMatches = config.grep.maxMatches;

      return {
        ...input,
        head_limit: maxMatches,
      };
    }

    case 'Glob': {
      // Glob can return huge lists of files
      // Add a reasonable limit if not present
      const head_limit = input.head_limit as number | undefined;
      if (typeof head_limit === 'number') {
        return null;
      }

      const maxFiles = config.glob.maxFiles;

      return {
        ...input,
        head_limit: maxFiles,
      };
    }

    default:
      // No limiting strategy for this tool
      return null;
  }
}
