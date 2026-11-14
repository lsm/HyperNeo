import type { NeoAskEntry, NeoTodoEntry } from '@hyperneo/shared/types/neo-ask';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoAskTodos } from '../NeoAskTodos.tsx';
import { neoTodoControlCall } from '../todo-controls.ts';

afterEach(() => {
  cleanup();
  sessionStorage.clear();
});

const todo = (id: string, patch: Partial<NeoTodoEntry> = {}): NeoTodoEntry => ({
  id,
  askId: 'ask',
  position: 0,
  priority: 'normal',
  dependsOn: null,
  title: `Todo ${id}`,
  doneWhen: 'PR 合进 main',
  check: null,
  instruction: 'Do it',
  named: null,
  state: 'todo',
  reason: null,
  blockedReason: null,
  nextAction: null,
  blockedBy: null,
  replacedBy: null,
  addedAfterStart: false,
  approvedAt: null,
  approvalQuestionId: null,
  report: null,
  evidence: null,
  createdAt: 1,
  updatedAt: 1,
  startedAt: null,
  finishedAt: null,
  status: '没开始',
  link: null,
  remoteLink: null,
  ...patch,
});

const entry = (patch: Partial<NeoAskEntry>): NeoAskEntry => ({
  ask: {
    id: 'ask',
    projectId: null,
    parentId: null,
    sessionId: 'neo',
    originMessageId: null,
    topic: null,
    title: 'iOS 卡片照网页第二版改',
    request: 'x',
    status: 'open',
    outcome: null,
    createdAt: 1,
    updatedAt: 1,
    settledAt: null,
  },
  state: 'todo',
  todos: [],
  doneCount: patch.todos?.filter((todo) => todo.state === 'done').length ?? 0,
  questions: [],
  ...patch,
});

const step = (app: ReturnType<typeof render>, title: string) =>
  fireEvent.click(app.getByRole('button', { name: `Step actions: ${title}` }));

describe('NeoAskTodos step controls', () => {
  it('Done, Pause, priority and Cancel on a running step each call its control', async () => {
    const running = todo('run', { state: 'doing', startedAt: 2, status: 'Working' });
    const onControl = vi.fn(async () => {});
    const app = render(
      <NeoAskTodos entry={entry({ todos: [running] })} onAnswer={vi.fn()} onControl={onControl} />
    );
    for (const [item, control] of [
      ['Mark done', { kind: 'done' }],
      ['Pause', { kind: 'hold' }],
      ['Priority: High', { kind: 'priority', priority: 'high' }],
      ['Cancel this step', { kind: 'cancel' }],
    ] as const) {
      step(app, 'Todo run');
      fireEvent.click(app.getByRole('menuitem', { name: item }));
      await waitFor(() => expect(onControl).toHaveBeenLastCalledWith(running, control));
      await waitFor(() => expect(app.queryByRole('menu')).toBeNull());
    }
    expect(onControl).toHaveBeenCalledTimes(4);
  });

  it('an unstarted step offers Hold, a settled one has no menu, and priority shows when not normal', () => {
    const app = render(
      <NeoAskTodos
        entry={entry({
          todos: [
            todo('wait', { priority: 'urgent' }),
            todo('plain'),
            todo('done', { state: 'done', priority: 'high', status: 'Done' }),
          ],
        })}
        onAnswer={vi.fn()}
        onControl={vi.fn(async () => {})}
      />
    );
    expect(app.container.querySelector('[data-todo-priority="urgent"]')?.textContent).toBe(
      'Urgent'
    );
    expect(app.container.querySelectorAll('[data-todo-priority]')).toHaveLength(1);
    expect(app.queryByRole('button', { name: 'Step actions: Todo done' })).toBeNull();
    step(app, 'Todo wait');
    expect(app.getByRole('menuitem', { name: 'Hold' })).toBeTruthy();
    expect(app.queryByRole('menuitem', { name: 'Pause' })).toBeNull();
  });

  it('a refused control shows the daemon reason on its step', async () => {
    const onControl = vi.fn(async () => {
      throw new Error('already_waiting: this todo already waits on an open card; answer that one.');
    });
    const app = render(
      <NeoAskTodos
        entry={entry({ todos: [todo('wait')] })}
        onAnswer={vi.fn()}
        onControl={onControl}
      />
    );
    step(app, 'Todo wait');
    fireEvent.click(app.getByRole('menuitem', { name: 'Hold' }));
    expect((await app.findByRole('alert')).textContent).toContain('already_waiting');
  });
});

describe('neoTodoControlCall', () => {
  it('maps each control to the operation the daemon runs', () => {
    const waiting = { id: 't', startedAt: null };
    expect(neoTodoControlCall(waiting, { kind: 'done' })).toEqual({
      name: 'neo.todo.done',
      input: { todoId: 't', reason: 'The human marked it done.' },
    });
    expect(neoTodoControlCall(waiting, { kind: 'cancel' }).name).toBe('neo.todo.remove');
    expect(neoTodoControlCall(waiting, { kind: 'hold' }).input.reason).toBe(
      'The human put it on hold.'
    );
    expect(neoTodoControlCall({ id: 't', startedAt: 1 }, { kind: 'hold' }).input.reason).toBe(
      'The human paused it.'
    );
    expect(neoTodoControlCall(waiting, { kind: 'priority', priority: 'low' })).toEqual({
      name: 'neo.todo.edit',
      input: { todoId: 't', priority: 'low' },
    });
  });
});
