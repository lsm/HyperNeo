import type { HookCallback, HookInput, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import superpipe, { type PipelineAPI } from 'superpipe';

export const NEO_BASH_TIMEOUT_ENV = {
  BASH_DEFAULT_TIMEOUT_MS: '120000',
  BASH_MAX_TIMEOUT_MS: '120000',
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
};

const TIMEOUT_CONTEXT =
  "This command hit the 2-minute limit and was stopped; its outcome is unknown. Don't retry it here. If it is long work (install, build, download), hand it to a worker with work.start/work.send — give the exact command and goal and ask it to report the result. If it may need a password or a GUI (e.g. installing an app), tell the human it needs them on the machine, give the exact command or download link, and how to confirm it worked. As root Neo, assign this through neo.todo.add {start:true}, or neo.todo.continue for an existing todo; that todo flow performs the work.start/work.send handoff. Do not call work.start/work.send directly.";

type BashResult = Extract<HookInput, { hook_event_name: 'PostToolUse' | 'PostToolUseFailure' }>;

const neoBashTimeoutContext = (superpipe({})('agent.neo-bash-timeout') as PipelineAPI)
  .input(['input'])
  .pipe(
    (input: HookInput): { value: BashResult } | { reason: null } =>
      (input.hook_event_name === 'PostToolUse' || input.hook_event_name === 'PostToolUseFailure') &&
      input.tool_name === 'Bash'
        ? { value: input }
        : { reason: null },
    'input',
    'result:out'
  )
  .pipe(
    (bash: BashResult): { value: BashResult['hook_event_name'] } | { reason: null } => {
      if (bash.hook_event_name === 'PostToolUseFailure') {
        return !bash.is_interrupt &&
          /^Exit code (?:137|143)\n/.test(bash.error) &&
          /^Command timed out after \d+(?:\.\d+)?(?:ms|[smhd])(?: \d+(?:\.\d+)?(?:ms|[smhd]))*$/m.test(
            bash.error
          )
          ? { value: bash.hook_event_name }
          : { reason: null };
      }
      const response = bash.tool_response;
      return response !== null &&
        typeof response === 'object' &&
        'timedOutAfterMs' in response &&
        typeof response.timedOutAfterMs === 'number' &&
        response.timedOutAfterMs > 0 &&
        !('backgroundTaskId' in response && response.backgroundTaskId)
        ? { value: bash.hook_event_name }
        : { reason: null };
    },
    'out',
    'result:out'
  )
  .pipe(
    (timeout: BashResult['hook_event_name']): SyncHookJSONOutput => ({
      hookSpecificOutput: {
        hookEventName: timeout,
        additionalContext: TIMEOUT_CONTEXT,
      },
    }),
    'out',
    'out'
  )
  .end('out') as (input: HookInput) => SyncHookJSONOutput | null;

export function createNeoBashTimeoutHook(): HookCallback {
  return async (input) => neoBashTimeoutContext(input) ?? {};
}
