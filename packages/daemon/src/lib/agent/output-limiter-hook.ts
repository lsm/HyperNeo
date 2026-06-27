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

// Output limiter configuration (resolved values used internally)
interface OutputLimiterConfig {
  enabled: boolean;
  bash: {
    headLines: number;
    tailLines: number;
    // Command prefixes (e.g. ['git']) that should not be wrapped, so
    // sandbox command-level exclusions still recognise the original tool.
    excludedCommandPrefixes: string[];
  };
  read: {
    maxLines: number;
  };
  grep: {
    maxMatches: number;
  };
  excludeTools: string[];
}

// Input shape: every nested value may be partial because global settings
// can be updated one field at a time (e.g. only bash.headLines).
export interface OutputLimiterConfigInput {
  enabled?: boolean;
  bash?: {
    headLines?: number;
    tailLines?: number;
    excludedCommandPrefixes?: string[];
  };
  read?: {
    maxLines?: number;
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
    excludedCommandPrefixes: [],
  },
  read: {
    maxLines: 1000,
  },
  grep: {
    maxMatches: 500,
  },
  excludeTools: [],
};

export function resolveConfig(input: OutputLimiterConfigInput = {}): OutputLimiterConfig {
  return {
    enabled: input.enabled ?? DEFAULT_CONFIG.enabled,
    bash: {
      headLines: input.bash?.headLines ?? DEFAULT_CONFIG.bash.headLines,
      tailLines: input.bash?.tailLines ?? DEFAULT_CONFIG.bash.tailLines,
      excludedCommandPrefixes:
        input.bash?.excludedCommandPrefixes ?? DEFAULT_CONFIG.bash.excludedCommandPrefixes,
    },
    read: {
      maxLines: input.read?.maxLines ?? DEFAULT_CONFIG.read.maxLines,
    },
    grep: {
      maxMatches: input.grep?.maxMatches ?? DEFAULT_CONFIG.grep.maxMatches,
    },
    excludeTools: input.excludeTools ?? DEFAULT_CONFIG.excludeTools,
  };
}

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
 *   bash: { headLines: 100, tailLines: 200 },
 * });
 *
 * const options = {
 *   hooks: {
 *     PreToolUse: [{ hooks: [hook] }]
 *   }
 * };
 * ```
 */
export function createOutputLimiterHook(config: OutputLimiterConfigInput = {}): HookCallback {
  const finalConfig = resolveConfig(config);
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

    // Return only the input mutation. We intentionally do NOT emit a
    // permissionDecision here; output limiting should not grant permission
    // on its own in restrictive permission modes.
    return {
      hookSpecificOutput: {
        hookEventName: input.hook_event_name,
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

      // Skip commands whose primary executable is sandbox-excluded (e.g. git),
      // so command-level sandbox exclusions still see the original command.
      const trimmed = command.trim();
      for (const prefix of config.bash.excludedCommandPrefixes) {
        if (trimmed === prefix || trimmed.startsWith(`${prefix} `)) {
          return null;
        }
      }

      const headLines = config.bash.headLines;
      const tailLines = config.bash.tailLines;

      // Create smart truncation command:
      // 1. Save stdout AND stderr to temp file, preserving the original exit status.
      // 2. If output exceeds limit: show first N + truncation message + last N.
      // 3. Otherwise: show all output.
      // 4. Clean up temp file and exit with the original status.
      //
      // A newline is inserted before the closing `)` of the subshell so that
      // commands whose last line is a heredoc delimiter (e.g. `cat <<'EOF' … EOF`)
      // keep their delimiter on its own line and are parsed correctly.
      const limitedCommand = `tmpfile=$(mktemp); (\n${command}\n) > "$tmpfile" 2>&1; exit_code=$?; total_lines=$(wc -l < "$tmpfile"); if [ "$total_lines" -gt ${headLines + tailLines} ]; then head -n ${headLines} "$tmpfile"; echo ""; echo "... [Truncated $(($total_lines - ${headLines + tailLines})) lines - showing first ${headLines} and last ${tailLines} lines] ..."; echo ""; tail -n ${tailLines} "$tmpfile"; else cat "$tmpfile"; fi; rm -f "$tmpfile"; exit $exit_code`;

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

      const maxLines = config.read.maxLines;

      return {
        ...input,
        limit: maxLines,
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

    default:
      // No limiting strategy for this tool
      return null;
  }
}
