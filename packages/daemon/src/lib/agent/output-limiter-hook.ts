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
    /** @deprecated Use maxLines instead. Legacy char-based limit from the pre-wiring schema. */
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
    excludedCommandPrefixes: [],
  },
  read: {
    maxLines: 1000,
  },
  grep: {
    // Match the SDK's built-in default (250) so injecting head_limit never
    // expands Grep output beyond what the SDK would have returned on its own.
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
      excludedCommandPrefixes:
        input.bash?.excludedCommandPrefixes ?? DEFAULT_CONFIG.bash.excludedCommandPrefixes,
    },
    read: {
      // Prefer maxLines; fall back to legacy maxChars (converted to lines at
      // ~50 chars/line) so upgraded installations don't silently lose their cap.
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

    // Return the mutated input with permissionDecision: 'allow'. The SDK
    // requires a permissionDecision for updatedInput to be reliably applied.
    // NeoKai defaults to bypassPermissions where 'allow' is a no-op; in
    // restrictive modes this auto-approves the call, which is an accepted
    // trade-off — the alternative is the limiter's mutations being silently
    // dropped and large outputs running uncapped.
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
 * Strip leading env var assignments and `env`/`command` prefixes from a
 * command so the primary executable is visible for exclusion checks.
 * Handles quoted values: `GIT_SSH_COMMAND='ssh -i key' git fetch` → `git fetch`.
 */
function stripEnvPrefixes(command: string): string {
  // Match repeated groups of:
  //   ENV_VAR=value   (value is \S+ or "..." or '...')
  //   env             (bare env prefix)
  //   command         (command bypass)
  return command.replace(
    /^((?:env\s+|command\s+)?(?:(?:[A-Za-z_]\w*=(?:[^\s'"\\]+|"[^"]*"|'[^']*'))\s+|env\s+|command\s+))*/,
    ''
  );
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

      // Skip background commands — the wrapper captures output to a temp file
      // and only prints it after the command exits, which breaks streaming for
      // long-lived background processes (dev servers, watchers, etc.).
      if (input.run_in_background === true) {
        return null;
      }

      // Skip simple commands that are unlikely to produce large output.
      // ls is NOT skipped because `ls -R` or `ls node_modules` can produce
      // thousands of lines. echo is NOT skipped because command substitution
      // (`echo "$(cat huge.log)"`) can expand to large output.
      const simpleCommands = /^(pwd|which|whoami)$/;
      if (simpleCommands.test(command.trim())) {
        return null;
      }

      // Skip pure directory-changing commands (no compound operators). `cd
      // <dir>` inside a subshell does not change the SDK's persistent cwd.
      // Compound commands like `cd pkg && bun test` or `cd pkg\nbun test` are
      // still wrapped because the trailing command produces output.
      const trimmed = command.trim();
      if (/^cd(\s|$)/.test(trimmed) && !/[;&|\n]/.test(trimmed)) {
        return null;
      }

      // Skip commands whose primary executable is explicitly excluded by the
      // user (e.g. via outputLimiter.bash.excludedCommandPrefixes, which may
      // be populated from sandbox.excludedCommands to preserve command-level
      // sandbox exclusions for commands like `git`).
      const effectiveCommand = stripEnvPrefixes(trimmed);
      for (const prefix of config.bash.excludedCommandPrefixes) {
        if (effectiveCommand === prefix || effectiveCommand.startsWith(`${prefix} `)) {
          return null;
        }
      }

      const headLines = config.bash.headLines;
      const tailLines = config.bash.tailLines;
      // Byte caps enforce a hard limit even when output has few but very long
      // lines (minified JSON, base64, \r-progress streams).
      const headBytes = headLines * 200;
      const tailBytes = tailLines * 200;
      const maxBytes = headBytes + tailBytes;

      // Create smart truncation command:
      //
      // A subshell `(...)` is used so that `exit` and `set -e` inside the
      // user command only terminate the subshell, not the wrapper shell.
      // This ensures the cat/head/tail/cleanup path always runs.
      //
      // To preserve cwd changes (which a subshell would normally discard),
      // the subshell writes its final `pwd` to a temp file. After truncation,
      // the wrapper replays the cwd change in the parent shell with `cd`.
      // If the command calls `exit` early, `pwd` never runs and the cwd file
      // is empty — matching the behavior of the unwrapped command.
      //
      // stderr is always captured: the subshell redirects both streams into
      // the temp file (`> "$tmpfile" 2>&1`). Commands that already pipe
      // stdout through `| head` are still wrapped because their stderr stream
      // remains uncapped without the wrapper.
      //
      // Known limitation: if the SDK kills the wrapper on timeout before the
      // cat/head/tail segment runs, partial output in the temp file is lost.
      const limitedCommand = `tmpfile=$(mktemp); cwdfile=$(mktemp); (\n${command}\npwd > "$cwdfile" 2>/dev/null\n) > "$tmpfile" 2>&1; exit_code=$?; total_lines=$(wc -l < "$tmpfile"); total_bytes=$(wc -c < "$tmpfile"); if [ "$total_lines" -gt ${headLines + tailLines} ] || [ "$total_bytes" -gt ${maxBytes} ]; then head -n ${headLines} "$tmpfile" | head -c ${headBytes}; echo ""; echo "... [Truncated $(($total_lines - ${headLines + tailLines})) lines / $(($total_bytes - ${maxBytes})) bytes - showing first ${headLines} and last ${tailLines} lines] ..."; echo ""; tail -n ${tailLines} "$tmpfile" | tail -c ${tailBytes}; else cat "$tmpfile"; fi; newcwd=$(cat "$cwdfile" 2>/dev/null); rm -f "$tmpfile" "$cwdfile"; [ -n "$newcwd" ] && cd "$newcwd" 2>/dev/null; exit $exit_code`;

      return {
        ...input,
        command: limitedCommand,
        description: `${input.description || 'Execute command'} (output: first ${headLines} + last ${tailLines} lines)`,
      };
    }

    case 'Read': {
      const maxLines = config.read.maxLines;

      // If an explicit limit is already within the cap (and not 0 which the
      // SDK treats as unlimited for some tools), leave it alone.
      if (typeof input.limit === 'number' && input.limit > 0 && input.limit <= maxLines) {
        return null;
      }

      // Otherwise inject or clamp to the configured cap.
      return {
        ...input,
        limit: maxLines,
      };
    }

    case 'Grep': {
      const maxMatches = config.grep.maxMatches;

      // head_limit: 0 means unlimited in the SDK, so treat it as uncapped.
      // Only skip when the explicit value is positive and within the cap.
      if (
        typeof input.head_limit === 'number' &&
        input.head_limit > 0 &&
        input.head_limit <= maxMatches
      ) {
        return null;
      }

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
