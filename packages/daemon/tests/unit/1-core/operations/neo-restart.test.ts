import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { neoStateNote, restartNeo } from '../../../../src/lib/neo/restart.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

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

  test('caps the asks it lists and says how many were left out', () => {
    const lines = neoStateNote(Array.from({ length: 53 }, () => entry)).split('\n');
    expect(JSON.parse(lines[1])).toHaveLength(50);
    expect(lines[2]).toBe('3 more open asks are left out; read them with neo.snapshot.');
  });
});

describe('neo.restart operation', () => {
  test('refuses every agent caller, Neo included', async () => {
    const db = await createTestDb();
    const service = new NeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus()
    );
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    try {
      expect(
        await invokeOperation(
          createOperationRegistry(createNeoOperations(service)),
          'neo.restart',
          {},
          { source: 'mcp', sessionId: 'neo:root', role: 'neo' }
        )
      ).toMatchObject({ value: { ok: false, reason: 'This action needs the user.' } });
    } finally {
      service.dispose();
      db.close();
    }
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
