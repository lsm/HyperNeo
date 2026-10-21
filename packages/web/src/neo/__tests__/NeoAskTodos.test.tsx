import type { NeoAskEntry, NeoQuestionEntry, NeoTodoEntry } from '@hyperneo/shared/types/neo-ask';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoAskTodos, neoQuestionAnswerLabel } from '../NeoAskTodos.tsx';
import { messageTime } from '../NeoMessage.tsx';
import { neoAskEntryGroup } from '../neo-asks.ts';
import { locale } from '../../lib/i18n/index.ts';

beforeEach(() => {
  locale.value = 'zh-Hans';
});

afterEach(() => {
  cleanup();
  locale.value = 'en';
});

const todo = (id: string, patch: Partial<NeoTodoEntry> = {}): NeoTodoEntry => ({
  id,
  askId: 'ask',
  position: 0,
  title: `Todo ${id}`,
  doneWhen: 'PR 合进 main',
  check: null,
  instruction: 'Do it',
  named: null,
  repo: null,
  state: 'todo',
  reason: null,
  blockedReason: null,
  nextAction: null,
  blockedBy: null,
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

const question = (id: string, patch: Partial<NeoQuestionEntry>): NeoQuestionEntry => ({
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
  retiredReason: null,
  replacedBy: null,
  createdAt: 1,
  ...patch,
});

const entry = (patch: Partial<NeoAskEntry>): NeoAskEntry => ({
  ask: {
    id: 'ask',
    projectId: null,
    repo: null,
    parentId: null,
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
  doneCount: 0,
  questions: [],
  ...patch,
});

describe('NeoAskTodos', () => {
  it.each(['open', 'answered', 'retired'] as const)(
    'renders safe question Markdown in the %s state with the real chat renderer',
    async (state) => {
      const text = [
        'First line',
        'Second line with **bold decision** and `inline code`.',
        '',
        '- First item',
        '- Second item',
        '',
        '| Option | Result |',
        '| --- | --- |',
        '| One | Ready |',
        '',
        '[Safe link](https://example.com/verify)',
        '',
        '```text',
        'synthetic code',
        '```',
        '',
        '<script>window.questionInjected = true</script>',
        '<b data-question-injected>Raw HTML</b>',
      ].join('\n');
      const app = render(
        <NeoAskTodos
          entry={entry({
            questions: [
              question('markdown', {
                text,
                state,
                answer: state === 'answered' ? 'Synthetic answer' : null,
                answeredAt: state === 'answered' ? 1 : null,
                retiredReason: state === 'retired' ? 'Synthetic retirement' : null,
              }),
            ],
          })}
          onAnswer={vi.fn()}
        />
      );
      if (state !== 'open')
        fireEvent.click(app.container.querySelector('[data-ask-details-toggle]')!);
      const body = app.container.querySelector('#neo-ref-question-markdown')!;
      await waitFor(() => expect(body.querySelector('table')).toBeTruthy());
      expect(body.querySelector('strong')?.textContent).toBe('bold decision');
      expect(body.querySelectorAll('ul li')).toHaveLength(2);
      expect(body.querySelector('br')).toBeTruthy();
      expect(body.querySelector('code')?.textContent).toBe('inline code');
      expect(body.querySelector('pre code')?.textContent).toContain('synthetic code');
      expect(body.querySelector('a[href="https://example.com/verify"]')).toBeTruthy();
      expect(body.querySelector('script, [data-question-injected]')).toBeNull();
      if (state === 'answered') expect(body.textContent).toContain('Synthetic answer');
      if (state === 'retired') expect(body.textContent).toContain('Synthetic retirement');
    }
  );

  it('dates an answer from an earlier day and shows only the time for today', () => {
    const earlier = new Date(2026, 0, 2, 9, 5).getTime();
    const today = Date.now();
    const app = render(
      <NeoAskTodos
        entry={entry({
          questions: [
            question('old', { state: 'answered', answer: 'yes', answeredAt: earlier }),
            question('new', { state: 'answered', answer: 'yes', answeredAt: today }),
          ],
        })}
        onAnswer={vi.fn()}
      />
    );
    fireEvent.click(app.container.querySelector('[data-ask-details-toggle]')!);
    const line = (id: string) =>
      app.container.querySelector(`#neo-ref-question-${id} > p`)?.textContent ?? '';
    expect(line('old')).toContain(messageTime(earlier)!.label);
    expect(line('old')).toMatch(/1月|Jan/);
    expect(line('new')).toContain(messageTime(today)!.label);
  });

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

  it('drops a todo the daemon prunes from a start question out of the answer', () => {
    const onAnswer = vi.fn();
    const start = (startTodos: string[]) =>
      entry({
        state: 'waiting',
        todos: [todo('a'), todo('b')],
        questions: [question('q', { kind: 'start', text: '开始', startTodos })],
      });
    const app = render(<NeoAskTodos entry={start(['a', 'b'])} onAnswer={onAnswer} />);
    app.rerender(<NeoAskTodos entry={start(['b'])} onAnswer={onAnswer} />);
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
            question('one', {
              kind: 'choice',
              options: ['Keep', 'Cards'],
              optionLabels: ['A', 'B'],
            }),
            question('many', {
              kind: 'choice',
              options: ['iPhone', 'iPad'],
              optionLabels: ['A', 'B'],
              multiple: true,
            }),
          ],
        })}
        onAnswer={onAnswer}
      />
    );
    fireEvent.click(app.getByRole('button', { name: 'B Cards' }));
    expect(onAnswer).toHaveBeenCalledWith('one', ['Cards']);
    fireEvent.click(app.getByRole('checkbox', { name: 'B iPad' }));
    fireEvent.click(app.getByRole('button', { name: '确定' }));
    expect(onAnswer).toHaveBeenLastCalledWith('many', ['iPad']);
  });

  it('letters each choice in order and wraps long options inside the card', () => {
    const long = [
      '保留现在的列表布局，只把每一行的间距、字号和状态标签重新调整一遍，让长标题在手机上也能完整显示而不被截断',
      'Switch every card to the compact table layout with sortable columns, sticky headers, and a much longer description',
      'https://example.test/a-very-long-unbroken-option-token-that-must-still-wrap-inside-the-card',
    ];
    const app = render(
      <NeoAskTodos
        entry={entry({
          questions: [
            question('one', { kind: 'choice', options: long, optionLabels: ['A', 'B', 'C'] }),
            question('many', {
              kind: 'choice',
              options: long,
              optionLabels: ['A', 'B', 'C'],
              multiple: true,
            }),
          ],
        })}
        onAnswer={() => {}}
      />
    );
    const one = app.container.querySelector('[data-ask-question="one"]')!;
    const buttons = [...one.querySelectorAll('[data-choice-option]')];
    expect(buttons.map((button) => button.textContent)).toEqual(
      long.map((option, index) => `${'ABC'[index]}${option}`)
    );
    for (const button of buttons) {
      expect(button.className).not.toMatch(/shrink-0|truncate|whitespace-nowrap|line-clamp/);
      expect(button.className).toContain('min-w-0');
      expect(button.className).toContain('max-w-full');
      expect(button.className).toContain('[overflow-wrap:anywhere]');
    }
    const many = app.container.querySelector('[data-ask-question="many"]')!;
    expect(
      [...many.querySelectorAll('[data-choice-option]')].map((label) => label.textContent)
    ).toEqual(long.map((option, index) => `${'ABC'[index]}${option}`));
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
    expect(app.container.querySelector('[aria-label="待办"]')?.textContent).not.toContain('Todo d');
    expect(app.getByText('新')).toBeTruthy();
    fireEvent.click(app.getByRole('button', { name: '打开 Todo a' }));
    expect(onOpen).toHaveBeenCalledWith('/session/w', 'Todo a');
  });

  it('shows a blocked todo with its reason in warning and its next action below', () => {
    const app = render(
      <NeoAskTodos
        entry={entry({
          state: 'waiting',
          todos: [
            todo('a', {
              state: 'blocked',
              blockedReason: 'CI 一直红',
              nextAction: '修好测试再推',
              blockedBy: 'check',
              status: '卡住了：CI 一直红',
            }),
            todo('b', { state: 'blocked', blockedReason: '等人', status: '卡住了：等人' }),
          ],
        })}
        onAnswer={() => {}}
      />
    );
    const reason = app.getByText('卡住了：CI 一直红');
    expect(reason.className).toContain('text-warning');
    const rowA = app.container.querySelector('[data-ask-todo="a"]')!;
    expect(rowA.querySelector('[data-todo-next-action]')?.textContent).toBe('下一步：修好测试再推');
    expect(rowA.textContent).not.toContain('check');
    const rowB = app.container.querySelector('[data-ask-todo="b"]')!;
    expect(rowB.querySelector('[data-todo-next-action]')).toBeNull();
    expect(app.getByText('卡住了：等人').className).toContain('text-warning');
  });

  it('keeps a non-blocked status muted and shows no next action', () => {
    const app = render(
      <NeoAskTodos
        entry={entry({
          state: 'doing',
          todos: [todo('a', { state: 'doing', nextAction: 'stale', status: '在做' })],
        })}
        onAnswer={() => {}}
      />
    );
    const row = app.container.querySelector('[data-ask-todo="a"]')!;
    expect(row.querySelector('[data-todo-next-action]')).toBeNull();
    expect(row.querySelector('.text-warning')).toBeNull();
  });

  it('marks an open ask done or drops it from its menu', () => {
    const onSettle = vi.fn();
    const app = render(<NeoAskTodos entry={entry({})} onAnswer={() => {}} onSettle={onSettle} />);
    fireEvent.click(app.getByRole('button', { name: '更多操作' }));
    fireEvent.click(app.getByRole('menuitem', { name: '标记做完' }));
    expect(onSettle).toHaveBeenCalledWith('done');
    cleanup();
    const settled = render(
      <NeoAskTodos
        entry={entry({ ask: { ...entry({}).ask, status: 'done' } })}
        onAnswer={() => {}}
        onSettle={onSettle}
      />
    );
    expect(settled.queryByRole('button', { name: '更多操作' })).toBeNull();
  });

  it('moves removed todos into Details, one line each with what replaced them', () => {
    const app = render(
      <NeoAskTodos
        entry={entry({
          state: 'doing',
          todos: [
            todo('d', { state: 'removed', status: '换成「Todo e」' }),
            todo('e', { state: 'doing' }),
          ],
        })}
        onAnswer={() => {}}
      />
    );
    expect(app.queryByText('Todo d')).toBeNull();
    fireEvent.click(app.getByRole('button', { name: '详情' }));
    const line = app.getByRole('list', { name: '已移除' }).querySelector('li')!;
    expect(line.textContent).toBe('Todo d — 换成「Todo e」');
    expect(line.id).toBe('neo-ref-todo-d');
  });

  it('keeps a removed todo still listed in an open start question out of Details', async () => {
    const app = render(
      <NeoAskTodos
        entry={entry({
          todos: [todo('d', { state: 'removed', status: '不要了' })],
          questions: [question('q', { kind: 'start', state: 'open', startTodos: ['d'] })],
        })}
        onAnswer={() => {}}
      />
    );
    expect(app.queryByRole('button', { name: '详情' })).toBeNull();
    expect(app.container.querySelectorAll('[data-ask-todo="d"]')).toHaveLength(1);
  });

  it('shows no Details button when there is nothing to put in it', () => {
    const app = render(
      <NeoAskTodos entry={entry({ todos: [todo('a', { state: 'doing' })] })} onAnswer={() => {}} />
    );
    expect(app.queryByRole('button', { name: '详情' })).toBeNull();
  });

  it('shows a retired question in Details with why it is no longer needed', async () => {
    const app = render(
      <NeoAskTodos
        entry={entry({
          questions: [
            question('q', {
              text: 'Allow a placeholder key?',
              state: 'retired',
              retiredReason: 'the root cause was found',
            }),
          ],
        })}
        onAnswer={() => {}}
      />
    );
    expect(app.queryByText('Allow a placeholder key?')).toBeNull();
    fireEvent.click(app.getByRole('button', { name: '详情' }));
    await waitFor(() =>
      expect(app.getByRole('list', { name: '不再需要' }).textContent).toContain(
        'Allow a placeholder key?'
      )
    );
    expect(app.getByRole('list', { name: '不再需要' }).textContent).toContain(
      '不再需要: the root cause was found'
    );
  });

  it('keeps answered questions in Details', async () => {
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
    fireEvent.click(app.getByRole('button', { name: '详情' }));
    await waitFor(() => expect(app.getByText('开始这 1 件？')).toBeTruthy());
    expect(app.getByText('— 开始 Todo a')).toBeTruthy();
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
    expect(
      neoQuestionAnswerLabel(
        question('q', {
          kind: 'choice',
          options: ['Keep', 'Cards', 'Table'],
          optionLabels: ['A', 'B', 'C'],
          answer: ['Keep', 'Table'],
          answeredBy: 'chat',
        }),
        []
      )
    ).toBe('A. Keep、C. Table');
  });
});

describe('neoAskEntryGroup', () => {
  it('puts waiting asks first and finished ones last', () => {
    expect(neoAskEntryGroup({ state: 'waiting' })).toBe('attention');
    expect(neoAskEntryGroup({ state: 'doing' })).toBe('running');
    expect(neoAskEntryGroup({ state: 'dropped' })).toBe('outcomes');
  });
});

describe('NeoAskTodos in English', () => {
  it('labels the card, todos and actions in English', () => {
    locale.value = 'en';
    const first = todo('a', { status: 'Not started', link: 'claude://claude.ai/epitaxy/local_1' });
    const base = entry({});
    const app = render(
      <NeoAskTodos
        entry={{
          ...base,
          ask: { ...base.ask, title: 'Ship it' },
          state: 'waiting',
          todos: [first],
        }}
        onAnswer={vi.fn()}
        onOpen={vi.fn()}
        onSettle={vi.fn()}
      />
    );
    expect(app.getByText('Waiting on you')).toBeTruthy();
    expect(app.getByRole('button', { name: 'Open Todo a' }).textContent).toContain('Open');
    expect(app.getByRole('button', { name: 'Ask actions' })).toBeTruthy();
    expect(app.container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
});

describe('Question full-version document', () => {
  it.each(['open', 'answered', 'retired'] as const)(
    'keeps the %s card short and opens literal full text',
    async (state) => {
      locale.value = 'en';
      const document =
        'Local version\n' +
        'Full original line  \n'.repeat(80) +
        '<script>unsafe()</script>\nRemote version';
      const view = render(
        <NeoAskTodos
          entry={entry({
            questions: [
              question('document', {
                text: 'direction.md: compact diff',
                state,
                document,
              } as Partial<NeoQuestionEntry>),
            ],
          })}
          onAnswer={() => {}}
        />
      );
      if (state !== 'open')
        fireEvent.click(view.container.querySelector('[data-ask-details-toggle]')!);
      expect(view.queryByRole('dialog')).toBeNull();
      fireEvent.click(view.getByRole('button', { name: 'View full versions' }));
      const dialog = await view.findByRole('dialog');
      expect(dialog.querySelector('pre')?.textContent).toBe(document);
      expect(dialog.querySelector('script')).toBeNull();
      expect(dialog.textContent).toContain('Remote version');
      fireEvent.click(view.getByRole('button', { name: /close/i }));
      await waitFor(() => expect(view.queryByRole('dialog')).toBeNull());
    }
  );
});
