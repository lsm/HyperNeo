import { expect, test } from 'bun:test';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import type { NeoAsk } from '@hyperneo/shared/types/neo-ask';
import { neoPlanContextHooks } from '../../../../src/lib/agent/neo-plan-hook.ts';
import { NeoMemoryRepository } from '../../../../src/storage/repositories/neo-memory-repository.ts';
import { runMigration542 } from '../../../../src/storage/schema/m542-neo-memories.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../src/storage/db-gateway/db-gateway.ts';

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
      additionalContext:
        'Open plans\nTopics used in the last 30 days (asks open or settled): none\nAsk a [open] topic=OAP Original questions=0',
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
      additionalContext:
        'Open plans\nTopics used in the last 30 days (asks open or settled): none\nAsk a [open] topic=OAP Changed questions=0',
    },
  });
});

async function memoryHooks(searches: string[]) {
  const db = new Database(':memory:');
  runMigration542(db);
  const store = new NeoMemoryRepository(gatewayFor(db));
  await store.save({ key: 'ci-tests', content: 'Let CI run the daemon tests.' });
  await store.save({ key: 'test-hosts', content: 'Heavy tests run on the build host.' });
  await store.save({ key: 'flaky-tests', content: 'Register flaky tests instead of retrying.' });
  await store.save({ key: 'tests-in-ci', content: 'Never run the full test suite locally.' });
  await store.save({ key: 'eastern', content: 'Tell the human times in US Eastern.' });
  const hooks = neoPlanContextHooks(
    async () => ({ asks: [], todos: [], questions: [] }),
    (query) => {
      searches.push(query);
      return store.search(query, 3);
    }
  );
  return (prompt: string) =>
    hooks.UserPromptSubmit![0].hooks[0](
      {
        session_id: 'synthetic',
        transcript_path: '',
        cwd: '/synthetic',
        hook_event_name: 'UserPromptSubmit',
        prompt,
      } as HookInput,
      undefined,
      { signal: new AbortController().signal }
    );
}

test('injects top three FTS memories for the human message', async () => {
  const searches: string[] = [];
  const submit = await memoryHooks(searches);
  const result = (await submit(
    '<already-said>Earlier reply</already-said>\n<human-message id="m1">\n\nWhere do the daemon tests run?\n\n</human-message>'
  )) as { hookSpecificOutput: { additionalContext: string } };
  expect(searches).toEqual(['Where do the daemon tests run?']);
  const context = result.hookSpecificOutput.additionalContext;
  expect(context.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(3);
  expect(context).toContain('- ci-tests: Let CI run the daemon tests.');
  expect(context).not.toContain('eastern');
});

test('skips memory search for worker-sent reports', async () => {
  const searches: string[] = [];
  const submit = await memoryHooks(searches);
  expect(
    JSON.stringify(
      await submit(
        '<session-message from-session="worker-1" origin="session">\nDone: daemon tests pass in CI.\n</session-message>'
      )
    )
  ).not.toContain('Memories');
  expect(searches).toEqual([]);
});

test('ignores stopword-only overlap in an unrelated query', async () => {
  const searches: string[] = [];
  const submit = await memoryHooks(searches);
  expect(
    JSON.stringify(
      await submit('<human-message id="m2">\n\nWhat is the weather there?\n\n</human-message>')
    )
  ).not.toContain('Memories');
  expect(searches).toEqual(['What is the weather there?']);
});
