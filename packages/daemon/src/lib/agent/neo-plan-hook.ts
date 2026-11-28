import type {
  HookCallback,
  Options,
  SessionStartHookInput,
  UserPromptSubmitHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { createNeoPlanContext, type NeoPlanFacts } from '../neo/plan-context-pipeline.ts';
import type { NeoMemory } from '../../storage/repositories/neo-memory-repository.ts';

const HUMAN_MESSAGE = /<human-message\b[^>]*>([\s\S]*?)<\/human-message>/g;

export function humanMessageText(prompt: string): string {
  return [...prompt.matchAll(HUMAN_MESSAGE)]
    .map((match) => match[1].replace(/<reference\b[^>]*>[\s\S]*?<\/reference>/g, '').trim())
    .filter(Boolean)
    .join('\n');
}

function memoryContext(memories: readonly NeoMemory[]): string | null {
  if (memories.length === 0) return null;
  return [
    'Memories that may apply (memory.read for the full entry):',
    ...memories.map((memory) => `- ${memory.key}: ${memory.content.slice(0, 500)}`),
  ].join('\n');
}

export function neoPlanContextHooks(
  readFacts: (withUnanswered?: boolean) => Promise<NeoPlanFacts>,
  searchMemories?: (query: string) => Promise<readonly NeoMemory[]>
): Pick<NonNullable<Options['hooks']>, 'SessionStart' | 'UserPromptSubmit'> {
  const context = createNeoPlanContext(readFacts);
  const start: HookCallback = async (input) => {
    const source = (input as SessionStartHookInput).source;
    return {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: await context(source === 'compact' ? 'compact' : 'startup'),
      },
    };
  };
  const prompt: HookCallback = async (input) => {
    const human = searchMemories && humanMessageText((input as UserPromptSubmitHookInput).prompt);
    const additionalContext = [
      await context('prompt'),
      human ? memoryContext(await searchMemories(human)) : null,
    ]
      .filter(Boolean)
      .join('\n\n');
    return additionalContext
      ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }
      : {};
  };
  return { SessionStart: [{ hooks: [start] }], UserPromptSubmit: [{ hooks: [prompt] }] };
}
