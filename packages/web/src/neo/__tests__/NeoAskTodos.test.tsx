import type { NeoAskEntry, NeoQuestion, NeoTodoEntry } from '@hyperneo/shared/types/neo-ask';
import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NeoAskTodos, neoQuestionAnswerLabel } from '../NeoAskTodos.tsx';
import { neoAskEntryGroup } from '../neo-asks.ts';

afterEach(cleanup);

const todo = (id: string, patch: Partial<NeoTodoEntry> = {}): NeoTodoEntry => ({
  id,
  askId: 'ask',
  position: 0,
  title: `Todo ${id}`,
  doneWhen: 'PR 合进 main',
  check: null,
  instruction: 'Do it',
  named: null,
  state: 'todo',
  reason: null,
  replacedBy: null,
  addedAfterStart: false,
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

const question = (id: string, patch: Partial<NeoQuestion>): NeoQuestion => ({
  id,
  askId: 'ask',
  text: `Question ${id}`,
  kind: 'reply',
  options: null,
  multiple: false,
  noLabel: null,
  yesLabel: null,
  startTodos: null,
  state: 'open',
  answer: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: 1,
  ...patch,
});

const entry = (patch: Partial<NeoAskEntry>): NeoAskEntry => ({
  ask: {
    id: 'ask',
    projectId: null,
    sessionId: 'neo',
    originMessageId: null,
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
  questions: [],
  ...patch,
});

describe('NeoAskTodos', () => {
  it('lists the todos of a start question with ticks and starts only the ticked ones', () => {
    const onAnswer = vi.fn();
    const app = render(
      <NeoAskTodos
        entry={entry({
          state: 'waiting',
          todos: [todo('a'), todo('b'), todo('c', { state: 'doing', status: '在做' })],
          questions: [
            question('q', { kind: 'start', text: '开始这 2 件？', startTodos: ['a', 'b'] }),
          ],
        })}
        onAnswer={onAnswer}
      />
    );
    expect(app.getByText('等你')).toBeTruthy();
    expect(app.container.querySelectorAll('[data-ask-todo="a"]')).toHaveLength(1);
    fireEvent.click(app.getByRole('checkbox', { name: '开始 Todo b' }));
    fireEvent.click(app.getByRole('button', { name: '开始' }));
    expect(onAnswer).toHaveBeenCalledWith('q', ['a']);
    fireEvent.click(app.getByRole('button', { name: '先不做' }));
    expect(onAnswer).toHaveBeenLastCalledWith('q', []);
  });

  it('ticks a todo appended to a start question on screen and keeps the human unticks', () => {
    const onAnswer = vi.fn();
    const start = (startTodos: string[]) =>
      entry({
        state: 'waiting',
        todos: [todo('a'), todo('b')],
        questions: [question('q', { kind: 'start', text: '开始', startTodos })],
      });
    const app = render(<NeoAskTodos entry={start(['a'])} onAnswer={onAnswer} />);
    fireEvent.click(app.getByRole('checkbox', { name: '开始 Todo a' }));
    app.rerender(<NeoAskTodos entry={start(['a', 'b'])} onAnswer={onAnswer} />);
    fireEvent.click(app.getByRole('button', { name: '开始' }));
    expect(onAnswer).toHaveBeenCalledWith('q', ['b']);
  });

  it('puts no on the left and yes on the right, and offers a chat reply', () => {
    const onAnswer = vi.fn();
    const onReply = vi.fn();
    const app = render(
      <NeoAskTodos
        entry={entry({
          state: 'waiting',
          questions: [
            question('q', {
              kind: 'yesno',
              text: '改成新开 Claude Code 会话？',
              noLabel: '先不做',
              yesLabel: '新开 Claude Code 会话',
            }),
          ],
        })}
        onAnswer={onAnswer}
        onReply={onReply}
      />
    );
    const buttons = [...app.container.querySelectorAll('[data-ask-question] button')].map(
      (button) => button.textContent
    );
    expect(buttons).toEqual(['在聊天里回复', '先不做', '新开 Claude Code 会话']);
    fireEvent.click(app.getByRole('button', { name: '新开 Claude Code 会话' }));
    expect(onAnswer).toHaveBeenCalledWith('q', 'yes');
    fireEvent.click(app.getByRole('button', { name: '在聊天里回复' }));
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ id: 'q' }));
  });

  it('answers a single choice at once and a multiple choice on confirm', () => {
    const onAnswer = vi.fn();
    const app = render(
      <NeoAskTodos
        entry={entry({
          questions: [
            question('one', { kind: 'choice', options: ['A', 'B'] }),
            question('many', { kind: 'choice', options: ['iPhone', 'iPad'], multiple: true }),
          ],
        })}
        onAnswer={onAnswer}
      />
    );
    fireEvent.click(app.getByRole('button', { name: 'B' }));
    expect(onAnswer).toHaveBeenCalledWith('one', ['B']);
    fireEvent.click(app.getByRole('checkbox', { name: 'iPad' }));
    fireEvent.click(app.getByRole('button', { name: '确定' }));
    expect(onAnswer).toHaveBeenLastCalledWith('many', ['iPad']);
  });

  it('draws each todo state with its line and opens a session', () => {
    const onOpen = vi.fn();
    const app = render(
      <NeoAskTodos
        entry={entry({
          state: 'doing',
          todos: [
            todo('a', { state: 'done', status: '#102 已合并', link: '/session/w' }),
            todo('b', { state: 'doing', status: '#103 开着，等 CI' }),
            todo('c', { state: 'failed', status: '会话停了：测试没过' }),
            todo('d', { state: 'removed', status: '换成「Todo e」' }),
            todo('e', { addedAfterStart: true }),
          ],
        })}
        onAnswer={() => {}}
        onOpen={onOpen}
      />
    );
    expect(app.getByText('在做')).toBeTruthy();
    expect(app.getByText('#102 已合并')).toBeTruthy();
    expect(app.getByText('Todo d').className).toContain('line-through');
    expect(app.getByText('新')).toBeTruthy();
    fireEvent.click(app.getByRole('button', { name: '打开 Todo a' }));
    expect(onOpen).toHaveBeenCalledWith('/session/w', 'Todo a');
  });

  it('marks an open ask done or drops it from its menu', () => {
    const onSettle = vi.fn();
    const app = render(<NeoAskTodos entry={entry({})} onAnswer={() => {}} onSettle={onSettle} />);
    fireEvent.click(app.getByRole('button', { name: 'Ask actions' }));
    fireEvent.click(app.getByRole('menuitem', { name: 'Mark done' }));
    expect(onSettle).toHaveBeenCalledWith('done');
    cleanup();
    const settled = render(
      <NeoAskTodos
        entry={entry({ ask: { ...entry({}).ask, status: 'done' } })}
        onAnswer={() => {}}
        onSettle={onSettle}
      />
    );
    expect(settled.queryByRole('button', { name: 'Ask actions' })).toBeNull();
  });

  it('keeps answered questions in Details', () => {
    const app = render(
      <NeoAskTodos
        entry={entry({
          state: 'done',
          todos: [todo('a', { state: 'done' })],
          questions: [
            question('q', {
              kind: 'start',
              text: '开始这 1 件？',
              state: 'answered',
              startTodos: ['a'],
              answer: ['a'],
              answeredBy: 'button',
            }),
          ],
        })}
        onAnswer={() => {}}
      />
    );
    expect(app.queryByText('已回答')).toBeNull();
    fireEvent.click(app.getByRole('button', { name: 'Details' }));
    expect(app.getByText(/开始这 1 件？ — 开始 Todo a/)).toBeTruthy();
  });
});

describe('neoQuestionAnswerLabel', () => {
  it('says chat answers in the human words and an empty multiple choice as none', () => {
    expect(
      neoQuestionAnswerLabel(
        question('q', { kind: 'yesno', answer: '用新会话', answeredBy: 'chat' }),
        []
      )
    ).toBe('用新会话');
    expect(neoQuestionAnswerLabel(question('q', { kind: 'choice', answer: [] }), [])).toBe(
      '都不要'
    );
  });
});

describe('neoAskEntryGroup', () => {
  it('puts waiting asks first and finished ones last', () => {
    expect(neoAskEntryGroup({ state: 'waiting' })).toBe('attention');
    expect(neoAskEntryGroup({ state: 'doing' })).toBe('running');
    expect(neoAskEntryGroup({ state: 'dropped' })).toBe('outcomes');
  });
});
