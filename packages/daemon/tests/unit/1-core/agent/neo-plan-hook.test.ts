import { expect, test } from 'bun:test';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { NeoAsk } from '@hyperneo/shared/types/neo-ask';
import { neoPlanContextHooks } from '../../../../src/lib/agent/neo-plan-hook.ts';

test('SDK start hooks rehydrate all plans and prompt hooks send only changes', async () => {
  let title = 'Original';
  const hooks = neoPlanContextHooks(async () => ({
    asks: [{ id: 'a', status: 'open', topic: 'OAP', title }] as NeoAsk[],
    todos: [],
    questions: [],
  }));
  const input = { session_id: 'synthetic', transcript_path: '', cwd: '/synthetic' };
  const invoke = async (event: 'SessionStart' | 'UserPromptSubmit', source = 'compact') =>
    hooks[event]![0].hooks[0](
      { ...input, hook_event_name: event, source, prompt: 'Hello' } as HookInput,
      undefined,
      { signal: new AbortController().signal }
    );
  expect(await invoke('SessionStart')).toMatchObject({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: 'Open plans\nAsk a [open] topic=OAP Original questions=0',
    },
  });
  expect(await invoke('UserPromptSubmit')).toEqual({});
  title = 'Changed';
  expect(await invoke('UserPromptSubmit')).toMatchObject({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'Ask a [open] topic=OAP Changed questions=0',
    },
  });
  expect(await invoke('SessionStart', 'resume')).toMatchObject({
    hookSpecificOutput: {
      additionalContext: 'Open plans\nAsk a [open] topic=OAP Changed questions=0',
    },
  });
});
