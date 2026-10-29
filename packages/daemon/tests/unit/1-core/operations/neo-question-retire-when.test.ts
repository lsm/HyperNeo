import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageHub } from '@hyperneo/shared';
import { createNeoQuestionOperations } from '../../../../src/lib/neo/question-operations.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

test('20707c94: an unlinked stale facts card retires and releases the todo it blocked', async () => {
  const run = mkdtempSync(join(tmpdir(), 'question-retire-'));
  const db = await createTestDb();
  const service = createNeoService(
    db,
    {} as SessionManager,
    { event: () => {} } as unknown as MessageHub,
    new InternalEventBus<DaemonInternalEventMap>()
  );
  const notes: string[] = [];
  service.packs = () => [];
  service.deliverForward = async (_session, _key, text) => {
    notes.push(String(text));
  };
  try {
    const store = service.todos;
    store.openAsk({
      id: 'ask',
      sessionId: 'neo',
      projectId: null,
      originMessageId: null,
      title: 'Qlark #78',
      request: 'Bot-approve and merge',
      createdAt: 1,
    });
    const check = { pack: 'core', kind: 'evidence', params: { path: join(run, 'approved.txt') } };
    const worker = store.addTodo(
      'worker',
      'ask',
      { title: 'Worker report', doneWhen: 'Reported', instruction: null, named: null, check },
      1
    );
    store.updateTodo(worker, { state: 'done' }, 2);
    writeFileSync(check.params.path, 'Bot APPROVED 16:08Z, five seconds before the card.');
    const operation = createNeoQuestionOperations(
      store,
      async () => {},
      async () => ({ ok: true })
    ).find((op) => op.name === 'neo.question.ask')!;
    const receipt = (await operation.execute(
      operation.inputSchema.parse({
        askId: 'ask',
        todoId: worker.id,
        kind: 'reply',
        text: 'qlark has no review bot and no CI',
        retireWhen: check,
      }),
      { source: 'mcp', sessionId: 'neo', role: 'neo' }
    )) as { ok: boolean; question: { id: string; todoId?: string } };
    expect(receipt.ok).toBe(true);
    expect(receipt.question.todoId).toBeUndefined();
    const waiting = store.addTodo(
      'waiting',
      'ask',
      {
        title: 'Qlark #78: bot-approve and merge',
        doneWhen: 'Merged',
        check: null,
        instruction: null,
        named: null,
      },
      3
    );
    store.updateTodo(
      waiting,
      { state: 'blocked', blockedBy: 'needs-human', blockedReason: 'Waiting on stale card' },
      3
    );
    await service.sweepPacks();
    expect(store.getQuestion(receipt.question.id)).toMatchObject({
      state: 'retired',
      retiredReason: `File ${check.params.path} exists.`,
      answer: null,
      answeredBy: null,
    });
    expect(store.getTodo(waiting.id)).toMatchObject({ state: 'todo', blockedBy: null });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(`File ${check.params.path} exists.`);
    expect(notes[0]).not.toContain('\n');
    await service.sweepPacks();
    expect(notes).toHaveLength(1);
  } finally {
    service.dispose();
    db.close();
    rmSync(run, { recursive: true, force: true });
  }
});
