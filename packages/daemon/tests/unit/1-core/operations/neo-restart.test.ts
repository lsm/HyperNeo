import { describe, expect, test } from 'bun:test';
import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';
import { neoStateNote, restartNeo } from '../../../../src/lib/neo/restart.ts';

const entry = {
  ask: { id: 'a1', title: 'Plant the moon garden' },
  state: 'doing',
  todos: [
    {
      id: 't1',
      title: 'Order blue seeds',
      state: 'doing',
      status: 'Working',
      doneWhen: 'Seeds ordered',
      link: '/session/w1',
    },
    { id: 't2', title: 'Old idea', state: 'removed', status: '', doneWhen: '', link: null },
  ],
  questions: [
    { id: 'q1', text: 'Which shop?', state: 'open' },
    { id: 'q2', text: 'Done?', state: 'answered' },
  ],
} as unknown as NeoAskEntry;

describe('neoStateNote', () => {
  test('lists open asks with live todos, their worker and only unanswered questions', () => {
    const [head, json, tail] = neoStateNote([entry]).split('\n');
    expect(head).toStartWith('Your context starts here.');
    expect(JSON.parse(json)).toEqual([
      {
        id: 'a1',
        title: 'Plant the moon garden',
        state: 'doing',
        todos: [
          {
            id: 't1',
            title: 'Order blue seeds',
            state: 'doing',
            status: 'Working',
            doneWhen: 'Seeds ordered',
            worker: '/session/w1',
          },
        ],
        questions: [{ id: 'q1', text: 'Which shop?' }],
      },
    ]);
    expect(tail).toContain('neo.snapshot');
  });
});

describe('restartNeo', () => {
  test('clears the root context before delivering the note to the same session', async () => {
    const steps: string[] = [];
    const result = await restartNeo({
      open: async () => 'neo:root',
      clear: async (sessionId) => {
        steps.push(`clear ${sessionId}`);
      },
      note: async (sessionId, text) => {
        steps.push(`note ${sessionId} ${text.split('\n')[0]}`);
      },
      entries: () => [],
    });
    expect(result).toEqual({ ok: true, sessionId: 'neo:root' });
    expect(steps).toEqual([
      'clear neo:root',
      'note neo:root Your context starts here. The open asks, their todos and the unanswered questions, read from the database:',
    ]);
  });
});
