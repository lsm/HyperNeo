import type { HookCallback, Options } from '@anthropic-ai/claude-agent-sdk';
import { createNeoPlanContext, type NeoPlanFacts } from '../neo/plan-context-pipeline.ts';

export function neoPlanContextHooks(
  readFacts: () => Promise<NeoPlanFacts>
): Pick<NonNullable<Options['hooks']>, 'SessionStart' | 'UserPromptSubmit'> {
  const context = createNeoPlanContext(readFacts);
  const start: HookCallback = async () => ({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: await context('startup'),
    },
  });
  const prompt: HookCallback = async () => {
    const additionalContext = await context('prompt');
    return additionalContext
      ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }
      : {};
  };
  return { SessionStart: [{ hooks: [start] }], UserPromptSubmit: [{ hooks: [prompt] }] };
}
