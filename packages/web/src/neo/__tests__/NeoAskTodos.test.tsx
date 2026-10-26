import guidanceQuestions from './fixtures/question-guidance.json';
import type { NeoAskEntry, NeoQuestionEntry, NeoTodoEntry } from '@hyperneo/shared/types/neo-ask';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NeoAskTodos, neoQuestionAnswerLabel } from '../NeoAskTodos.tsx';
import { messageTime } from '../NeoMessage.tsx';
import { neoAskEntriesInOrder, neoAskEntryGroup, neoDonePageMerge } from '../neo-asks.ts';
import { locale } from '../../lib/i18n/index.ts';
import * as clipboard from '../../lib/utils.ts';

beforeEach(() => {
  locale.value = 'zh-Hans';
  sessionStorage.clear();
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
  it('copies a quote after expanding and reopening a collapsed card', async () => {
    locale.value = 'en';
    const copy = vi.spyOn(clipboard, 'copyToClipboard').mockResolvedValue(true);
    const data = entry({});
    data.ask.outcome = '> Ready **to send**.\n>\n> Thank you.';
    const app = render(<NeoAskTodos entry={data} onAnswer={vi.fn()} />);
    try {
      expect(app.queryByRole('button', { name: 'Copy quote' })).toBeNull();
      fireEvent.click(app.getByRole('button', { name: /Details$/ }));
      await waitFor(() => expect(app.getByRole('button', { name: 'Copy quote' })).toBeTruthy());
      fireEvent.click(app.getByRole('button', { name: 'Copy quote' }));
      await waitFor(() => expect(copy).toHaveBeenLastCalledWith('Ready to send.\n\nThank you.'));
      fireEvent.click(app.getByRole('button', { name: /Details$/ }));
      expect(app.queryByRole('button', { name: 'Copy quote' })).toBeNull();
      fireEvent.click(app.getByRole('button', { name: /Details$/ }));
      await waitFor(() =>
        expect(app.getAllByRole('button', { name: 'Copy quote' })).toHaveLength(1)
      );
    } finally {
      copy.mockRestore();
    }
  });

  it.each(['open', 'done', 'dropped'] as const)('offers ask Reply for a %s card', (status) => {
    locale.value = 'en';
    const data = entry({});
    data.ask.status = status;
    const reply = vi.fn();
    const settle = vi.fn();
    const app = render(
      <NeoAskTodos entry={data} onAnswer={vi.fn()} onReplyAsk={reply} onSettle={settle} />
    );
    fireEvent.click(app.getByRole('button', { name: 'Ask actions' }));
    expect(app.queryByRole('menuitem', { name: 'Mark done' }) !== null).toBe(status === 'open');
    fireEvent.click(app.getByRole('menuitem', { name: 'Reply', exact: true }));
    expect(reply).toHaveBeenCalledOnce();
    expect(settle).not.toHaveBeenCalled();
  });

  it('disables ask Reply while the card is unavailable', () => {
    locale.value = 'en';
    const reply = vi.fn();
    const app = render(
      <NeoAskTodos entry={entry({})} disabled onAnswer={vi.fn()} onReplyAsk={reply} />
    );
    fireEvent.click(app.getByRole('button', { name: 'Ask actions' }));
    expect((app.getByRole('menuitem', { name: 'Reply' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(app.getByRole('menuitem', { name: 'Reply' }));
    expect(reply).not.toHaveBeenCalled();
  });

  it('renders settled discussion document and PR links without completing execution', async () => {
    locale.value = 'en';
    const original = entry({
      todos: [todo('execute', { title: 'Implement positioning', state: 'todo' })],
    });
    const outcome =
      'Decision: beginner gardeners.\n\n[Positioning document](https://example.test/positioning.md) · [Implementation PR](https://github.com/example/project/pull/8)';
    const app = render(
      <NeoAskTodos entry={{ ...original, ask: { ...original.ask, outcome } }} onAnswer={vi.fn()} />
    );
    fireEvent.click(app.getByRole('button', { name: /Details$/ }));
    await waitFor(() =>
      expect(app.getByRole('link', { name: 'Positioning document' }).getAttribute('href')).toBe(
        'https://example.test/positioning.md'
      )
    );
    expect(app.getByRole('link', { name: 'Implementation PR' }).getAttribute('href')).toBe(
      'https://github.com/example/project/pull/8'
    );
    expect(
      app.container.querySelector('[data-ask-todo="execute"]')?.getAttribute('data-todo-state')
    ).toBe('todo');
  });

  it('keeps the focused session opener on the ask after its question is retired', () => {
    locale.value = 'en';
    const onOpen = vi.fn();
    const focusedSession = {
      adapter: 'hyperneo',
      id: 'discussion',
      name: 'Positioning discussion',
      label: 'HyperNeo · Positioning discussion',
      provider: 'Anthropic',
      link: '/session/discussion',
    };
    const original = entry({
      questions: [question('prepared', { state: 'retired', retiredReason: 'Discuss directly' })],
    });
    const app = render(
      <NeoAskTodos
        entry={{ ...original, ask: { ...original.ask, ...{ focusedSession } } }}
        onOpen={onOpen}
        onAnswer={vi.fn()}
      />
    );
    expect(app.container.querySelector('[data-ask-question]')).toBeNull();
    expect(app.getByText('Positioning discussion · Anthropic')).toBeTruthy();
    fireEvent.click(app.getByRole('button', { name: 'Open session: Positioning discussion' }));
    expect(onOpen).toHaveBeenCalledWith('/session/discussion', focusedSession.label);
  });

  it.each(['codex://threads/worker', 'https://claude.ai/code/synthetic-bridge', '/session/worker'])(
    'opens a question source through the existing opener: %s',
    async (link) => {
      locale.value = 'en';
      const onOpen = vi.fn();
      const onAnswer = vi.fn();
      const sourceSession = {
        adapter: 'codex-desktop',
        id: 'worker',
        name: 'Review worker',
        label: 'Codex · Review worker',
        provider: 'Codex',
        link,
      };
      const app = render(
        <NeoAskTodos
          entry={entry({
            questions: [
              question('source', {
                kind: 'yesno',
                noLabel: 'Wait',
                yesLabel: 'Approve',
                ...{ sourceSession },
              }),
            ],
          })}
          onOpen={onOpen}
          onAnswer={onAnswer}
        />
      );
      const body = app.container.querySelector('#neo-ref-question-source')!;
      expect(body.textContent).not.toContain('Review worker');
      expect(body.textContent).not.toContain('Codex');
      const open = app.getByRole('button', { name: 'Open session: Review worker', exact: true });
      expect(open.textContent).toBe('Open');
      expect(open.querySelector('svg')).toBeNull();
      fireEvent.click(open);
      expect(onOpen).toHaveBeenCalledWith(link, 'Codex · Review worker');
      fireEvent.click(app.getByRole('button', { name: 'Approve', exact: true }));
      expect(onAnswer).toHaveBeenCalledWith('source', 'yes');
    }
  );

  it.each([
    { link: null, opener: true },
    { link: 'codex://threads/worker', opener: false },
  ])('omits the source header when navigation is unavailable: %j', ({ link, opener }) => {
    locale.value = 'en';
    const onAnswer = vi.fn();
    const app = render(
      <NeoAskTodos
        entry={entry({
          questions: [
            question('source', {
              kind: 'yesno',
              yesLabel: 'Approve',
              noLabel: 'Wait',
              sourceSession: {
                adapter: 'claude-code',
                id: 'worker',
                name: 'Terminal worker',
                label: 'Claude Code · Terminal worker',
                provider: 'Claude',
                link,
              },
            }),
          ],
        })}
        onOpen={opener ? vi.fn() : undefined}
        onAnswer={onAnswer}
      />
    );
    const header = app.container.querySelector('[data-question-source]');
    expect(header).toBeNull();
    expect(app.queryByRole('button', { name: /^Open session:/ })).toBeNull();
    fireEvent.click(app.getByRole('button', { name: 'Approve', exact: true }));
    expect(onAnswer).toHaveBeenCalledWith('source', 'yes');
  });

  it('shows a short localized opener even when the source title is broken', () => {
    const onOpen = vi.fn();
    const app = render(
      <NeoAskTodos
        entry={entry({
          questions: [
            question('source', {
              kind: 'reply',
              sourceSession: {
                adapter: 'codex-desktop',
                id: 'worker',
                name: '( · Codex',
                label: 'Codex · ( · Codex',
                provider: 'Codex',
                link: 'codex://threads/worker',
              },
            }),
          ],
        })}
        onOpen={onOpen}
        onAnswer={vi.fn()}
      />
    );
    expect(app.container.textContent).not.toContain('( · Codex');
    const open = app.getByRole('button', { name: '打开会话：( · Codex', exact: true });
    expect(open.textContent).toBe('打开');
    fireEvent.click(open);
    expect(onOpen).toHaveBeenCalledWith('codex://threads/worker', 'Codex · ( · Codex');
  });

  it('names the destination by its ID when the source has no title', () => {
    locale.value = 'en';
    const app = render(
      <NeoAskTodos
        entry={entry({
          questions: [
            question('source', {
              kind: 'reply',
              sourceSession: {
                adapter: 'hyperneo',
                id: 'worker-without-title',
                name: null,
                label: 'HyperNeo · worker-without-title',
                provider: 'Anthropic',
                link: '/session/worker-without-title',
              },
            }),
          ],
        })}
        onOpen={vi.fn()}
        onAnswer={vi.fn()}
      />
    );
    const open = app.getByRole('button', {
      name: 'Open session: worker-without-title',
      exact: true,
    });
    expect(open.textContent).toBe('Open');
    expect(app.container.querySelector('[data-question-source]')?.textContent).toBe('Open');
  });

  it('offers no session opener for a question without one source', () => {
    locale.value = 'en';
    const app = render(
      <NeoAskTodos
        entry={entry({ questions: [question('general', {})] })}
        onOpen={vi.fn()}
        onAnswer={vi.fn()}
      />
    );
    expect(app.queryByRole('button', { name: /^Open session:/ })).toBeNull();
  });

  it.each(guidanceQuestions)('renders the concise guidance example: $title', async (fixture) => {
    const app = render(
      <NeoAskTodos
        entry={entry({ questions: [question('guidance', { text: fixture.text })] })}
        onAnswer={vi.fn()}
      />
    );
    const body = app.container.querySelector('#neo-ref-question-guidance')!;
    await waitFor(() => expect(body.querySelector('strong')?.textContent).toBe(fixture.keyChoice));
    expect(body.querySelector('p')?.textContent).toBe(fixture.title);
    expect(body.querySelectorAll('ul li')).toHaveLength(fixture.bullets);
    expect(body.querySelectorAll('table tr')).toHaveLength(fixture.tableRows);
    expect(body.textContent).not.toContain('**');
  });

  const detailed = () =>
    entry({
      todos: ['a', 'b', 'c'].map((id) =>
        todo(id, {
          status: `Working on ${id}: ${'A long status line. '.repeat(15)}`,
          report: `Report ${id}: ${'Detailed synthetic report. '.repeat(12)}`,
          evidence: `Evidence ${id}: ${'Observed synthetic result. '.repeat(12)}`,
        })
      ),
    });

  it('expands a todo by tapping its text and turns its left hint', () => {
    locale.value = 'en';
    const data = detailed();
    const app = render(<NeoAskTodos entry={data} onAnswer={vi.fn()} />);
    const header = app.getByRole('button', { name: 'Show details: Todo a' });
    const hint = header.querySelector('[data-todo-hint]')!;
    expect(hint.getAttribute('class')).not.toContain('rotate-90');
    fireEvent.click(app.getByText('Todo a'));
    expect(app.getByText(data.todos[0].report!.trim())).toBeTruthy();
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(hint.getAttribute('class')).toContain('rotate-90');
    fireEvent.click(app.getByText('Todo a'));
    expect(app.queryByText(data.todos[0].report!.trim())).toBeNull();
  });

  it('leaves the trailing column to Open alone', () => {
    locale.value = 'en';
    const data = detailed();
    data.todos[0] = {
      ...data.todos[0],
      link: '/session/synthetic',
      worker: {
        id: 'synthetic',
        adapter: 'codex-desktop',
        name: 'Synthetic worker',
        label: 'Codex · Synthetic worker',
      },
    };
    const onOpen = vi.fn();
    const app = render(<NeoAskTodos entry={data} onAnswer={vi.fn()} onOpen={onOpen} />);
    const row = app.container.querySelector('[data-ask-todo="a"]')!;
    expect(row.classList.contains('grid-cols-[1rem_minmax(0,1fr)_auto]')).toBe(true);
    const trailing = row.lastElementChild!;
    expect(trailing.querySelectorAll('button')).toHaveLength(1);
    fireEvent.click(app.getByRole('button', { name: 'Open Todo a' }));
    expect(onOpen).toHaveBeenCalledWith('/session/synthetic', 'Codex · Synthetic worker');
    expect(app.queryByText(data.todos[0].report!.trim())).toBeNull();
  });

  it('collapses detailed todos by default and the bottom control opens or closes everything', () => {
    locale.value = 'en';
    const data = detailed();
    const app = render(<NeoAskTodos entry={data} onAnswer={vi.fn()} />);
    for (const item of data.todos) expect(app.queryByText(item.report!.trim())).toBeNull();
    fireEvent.click(app.getByRole('button', { name: 'Show details: Todo a' }));
    expect(app.queryByText(data.todos[1].report!.trim())).toBeNull();
    const all = app.container.querySelector('[data-ask-details-toggle]')!;
    expect(app.queryByRole('button', { name: 'Expand all' })).toBeNull();
    fireEvent.click(all);
    for (const item of data.todos) expect(app.getByText(item.report!.trim())).toBeTruthy();
    expect(all.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(all);
    for (const item of data.todos) {
      expect(app.queryByText(item.report!.trim())).toBeNull();
      expect(
        app
          .getByRole('button', { name: `Show details: ${item.title}` })
          .getAttribute('aria-expanded')
      ).toBe('false');
    }
  });

  it('remembers each card within the session across switches and remounts without auto-opening new todos', () => {
    locale.value = 'en';
    const data = detailed();
    const other = { ...data, ask: { ...data.ask, id: 'other', title: 'Other card' } };
    const app = render(<NeoAskTodos entry={data} onAnswer={vi.fn()} />);
    fireEvent.click(app.getByRole('button', { name: 'Show details: Todo a' }));
    app.rerender(<NeoAskTodos entry={other} onAnswer={vi.fn()} />);
    expect(app.queryByText(data.todos[0].report!.trim())).toBeNull();
    fireEvent.click(app.getByRole('button', { name: 'Show details: Todo b' }));
    app.rerender(<NeoAskTodos entry={data} onAnswer={vi.fn()} />);
    expect(app.getByText(data.todos[0].report!.trim())).toBeTruthy();
    expect(app.queryByText(data.todos[1].report!.trim())).toBeNull();
    app.unmount();
    const again = render(
      <NeoAskTodos
        entry={{ ...data, todos: [...data.todos, todo('new', { report: 'Fresh report' })] }}
        onAnswer={vi.fn()}
      />
    );
    expect(again.getByText(data.todos[0].report!.trim())).toBeTruthy();
    expect(
      again.getByRole('button', { name: 'Show details: Todo new' }).getAttribute('aria-expanded')
    ).toBe('false');
    expect(again.queryByText('Fresh report')).toBeNull();
  });

  it('omits report and evidence duplicates of each other or the displayed status', () => {
    locale.value = 'en';
    const app = render(
      <NeoAskTodos
        entry={entry({
          todos: [
            todo('a', { status: 'Doing', report: ' Same details ', evidence: 'Same details' }),
            todo('b', { status: 'Done', report: ' Done ', evidence: '  ' }),
          ],
        })}
        onAnswer={vi.fn()}
      />
    );
    fireEvent.click(app.getByRole('button', { name: 'Show details: Todo a' }));
    expect(app.getAllByText('Same details')).toHaveLength(1);
    expect(app.getAllByText('Done')).toHaveLength(1);
  });

  it('gives a todo with nothing more to show no hint and no toggle', () => {
    locale.value = 'en';
    const app = render(
      <NeoAskTodos
        entry={entry({ todos: [todo('a', { report: 'More here' }), todo('b'), todo('c')] })}
        onAnswer={vi.fn()}
      />
    );
    const plain = app.container.querySelector('[data-ask-todo="b"]')!;
    expect(plain.querySelector('[data-todo-hint]')).toBeNull();
    expect(app.queryByRole('button', { name: 'Show details: Todo b' })).toBeNull();
    expect(app.getByRole('button', { name: 'Show details: Todo a' })).toBeTruthy();
    expect(app.container.querySelector('[data-ask-details-toggle]')).toBeNull();
  });

  it('keeps Open separate from the disclosure in Chinese', () => {
    const data = detailed();
    data.todos[0].link = '/session/worker';
    const onOpen = vi.fn();
    const app = render(<NeoAskTodos entry={data} onAnswer={vi.fn()} onOpen={onOpen} />);
    fireEvent.click(app.getByRole('button', { name: '打开 Todo a' }));
    expect(onOpen).toHaveBeenCalledWith('/session/worker', 'Todo a');
    expect(app.queryByText(data.todos[0].report!.trim())).toBeNull();
    fireEvent.click(app.getByRole('button', { name: '显示详情：Todo a' }));
    expect(app.getByText(data.todos[0].report!.trim())).toBeTruthy();
  });

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

  it('shows an unverified close with a warning instead of a done checkmark', () => {
    const app = render(
      <NeoAskTodos
        entry={entry({
          todos: [
            todo('unverified', {
              state: 'closed_unverified',
              status: 'Closed unverified',
              statusCodes: [{ code: 'todo.closedUnverified', params: {} }],
            }),
          ],
        })}
        onAnswer={() => {}}
      />
    );
    const row = app.container.querySelector('[data-todo-state="closed_unverified"]');
    expect(row?.textContent).toContain('已关闭，未验证');
    expect(row?.textContent).toContain('?');
    expect(row?.textContent).not.toContain('✓');
    expect(row?.textContent).not.toContain('做完了');
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
    fireEvent.click(app.getByRole('button', { name: '显示详情：Todo a' }));
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

  it.each([new Error('stop_failed: offline'), 'settle rejected'])(
    'shows a failed Mark done on its own card and allows retry: %s',
    async (failure) => {
      const onSettle = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);
      const app = render(<NeoAskTodos entry={entry({})} onAnswer={() => {}} onSettle={onSettle} />);
      fireEvent.click(app.getByRole('button', { name: '更多操作' }));
      fireEvent.click(app.getByRole('menuitem', { name: '标记做完' }));
      await waitFor(() =>
        expect(app.getByRole('alert').textContent).toContain(
          failure instanceof Error ? failure.message : '请求没能关闭，请重试。'
        )
      );
      await waitFor(() => expect(app.queryByRole('menu')).toBeNull());
      fireEvent.click(app.getByRole('button', { name: '更多操作' }));
      fireEvent.click(await app.findByRole('menuitem', { name: '标记做完' }));
      await waitFor(() => expect(app.queryByRole('alert')).toBeNull());
      expect(onSettle).toHaveBeenCalledTimes(2);
    }
  );

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
    fireEvent.click(app.getByRole('button', { name: '更多 — 详情' }));
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
    expect(app.queryByRole('button', { name: '更多 — 详情' })).toBeNull();
    expect(app.container.querySelectorAll('[data-ask-todo="d"]')).toHaveLength(1);
  });

  it('shows no Details button when there is nothing to put in it', () => {
    const app = render(
      <NeoAskTodos entry={entry({ todos: [todo('a', { state: 'doing' })] })} onAnswer={() => {}} />
    );
    expect(app.queryByRole('button', { name: '更多 — 详情' })).toBeNull();
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
    fireEvent.click(app.getByRole('button', { name: '更多 — 详情' }));
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
    fireEvent.click(app.getByRole('button', { name: '更多 — 详情' }));
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
    expect(neoAskEntryGroup({ state: 'waiting', todos: [] })).toBe('attention');
    expect(neoAskEntryGroup({ state: 'doing', todos: [] })).toBe('running');
    expect(neoAskEntryGroup({ state: 'dropped', todos: [] })).toBe('outcomes');
  });

  it('moves a card holding a blocked todo to the very top', () => {
    const blocked = entry({ state: 'doing', todos: [todo('b', { state: 'blocked' })] });
    const waiting = entry({ state: 'waiting' });
    expect(neoAskEntryGroup(blocked)).toBe('attention');
    expect(neoAskEntryGroup({ ...blocked, state: 'done' })).toBe('outcomes');
    expect(neoAskEntryGroup({ ...blocked, state: 'dropped' })).toBe('outcomes');
    expect(neoAskEntriesInOrder([waiting, blocked, entry({ state: 'doing' })])).toEqual([
      blocked,
      waiting,
      expect.objectContaining({ state: 'doing' }),
    ]);
  });
});

describe('neoDonePageMerge', () => {
  const done = (n: number) => todo(`d${n}`, { state: 'done' });
  const ids = (todos: readonly NeoTodoEntry[]) => todos.map((item) => item.id);

  it('restarts from the first page without dropping done todos paged past it', () => {
    const paged = Array.from({ length: 22 }, (_, n) => done(n + 1));
    const page = Array.from({ length: 20 }, (_, n) => done(n));
    const merged = neoDonePageMerge(paged, paged, page, true);
    expect(ids(merged.paged)).toEqual([
      ...Array.from({ length: 20 }, (_, n) => `d${n}`),
      'd20',
      'd21',
      'd22',
    ]);
    expect(merged.stalled).toBe(false);
  });
});

describe('done todos on a card', () => {
  beforeEach(() => {
    locale.value = 'en';
  });
  const done = (id: string) => todo(id, { state: 'done', status: 'Done', title: `Done ${id}` });
  const rows = (app: ReturnType<typeof render>) =>
    [...app.container.querySelectorAll('[data-ask-todo]')].map((row) =>
      row.getAttribute('data-ask-todo')
    );

  it('shows up to three done todos and folds more behind one control', () => {
    const few = render(
      <NeoAskTodos
        entry={entry({ todos: [todo('a'), done('d1'), done('d2')], doneCount: 2 })}
        onAnswer={vi.fn()}
      />
    );
    expect(rows(few)).toEqual(['a', 'd1', 'd2']);
    cleanup();
    const many = render(
      <NeoAskTodos
        entry={entry({
          todos: [todo('a'), done('d1'), done('d2'), done('d3'), done('d4')],
          doneCount: 4,
        })}
        onAnswer={vi.fn()}
      />
    );
    expect(rows(many)).toEqual(['a']);
    fireEvent.click(many.getByRole('button', { name: '4 done — show more' }));
    expect(rows(many)).toEqual(['a', 'd1', 'd2', 'd3', 'd4']);
    expect(many.queryByRole('button', { name: /done — show more/ })).toBeNull();
  });

  it('pages the rest when the snapshot sent only some of the done todos', async () => {
    const onLoadDone = vi.fn().mockResolvedValueOnce({
      ok: true,
      todos: [done('d2'), done('d3'), done('d4'), done('d5')],
      doneCount: 5,
      nextOffset: null,
    });
    const app = render(
      <NeoAskTodos
        entry={entry({ todos: [todo('a'), done('d1')], doneCount: 5 })}
        onAnswer={vi.fn()}
        onLoadDone={onLoadDone}
      />
    );
    fireEvent.click(app.getByRole('button', { name: '5 done — show more' }));
    await waitFor(() => expect(rows(app)).toEqual(['a', 'd1', 'd2', 'd3', 'd4', 'd5']));
    expect(onLoadDone).toHaveBeenCalledWith('ask', 1);
  });

  it('keeps each done todo once when the done list shifts between pages', async () => {
    const onLoadDone = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        todos: [done('d1'), done('d2')],
        doneCount: 5,
        nextOffset: 2,
      })
      .mockResolvedValueOnce({ ok: true, todos: [done('d2')], doneCount: 5, nextOffset: null })
      .mockResolvedValueOnce({
        ok: true,
        todos: [done('d0'), done('d1'), done('d2'), done('d3'), done('d4')],
        doneCount: 5,
        nextOffset: null,
      });
    const app = render(
      <NeoAskTodos
        entry={entry({ todos: [todo('a')], doneCount: 5 })}
        onAnswer={vi.fn()}
        onLoadDone={onLoadDone}
      />
    );
    fireEvent.click(app.getByRole('button', { name: '5 done — show more' }));
    await waitFor(() => expect(rows(app)).toEqual(['a', 'd1', 'd2']));
    fireEvent.click(app.getByRole('button', { name: '3 done — show more' }));
    await waitFor(() => expect(onLoadDone).toHaveBeenCalledTimes(2));
    expect(rows(app)).toEqual(['a', 'd1', 'd2']);
    fireEvent.click(app.getByRole('button', { name: '3 done — show more' }));
    await waitFor(() => expect(rows(app)).toEqual(['a', 'd0', 'd1', 'd2', 'd3', 'd4']));
    expect(onLoadDone).toHaveBeenLastCalledWith('ask', 0);
  });

  it('lets the snapshot win over a paged done todo it now lists another way', async () => {
    const onLoadDone = vi.fn().mockResolvedValueOnce({
      ok: true,
      todos: [done('d1'), done('d2')],
      doneCount: 5,
      nextOffset: 2,
    });
    const app = render(
      <NeoAskTodos
        entry={entry({ todos: [todo('a')], doneCount: 5 })}
        onAnswer={vi.fn()}
        onLoadDone={onLoadDone}
      />
    );
    fireEvent.click(app.getByRole('button', { name: '5 done — show more' }));
    await waitFor(() => expect(rows(app)).toEqual(['a', 'd1', 'd2']));
    app.rerender(
      <NeoAskTodos
        entry={entry({ todos: [todo('a'), todo('d1', { state: 'doing' })], doneCount: 4 })}
        onAnswer={vi.fn()}
        onLoadDone={onLoadDone}
      />
    );
    expect(rows(app)).toEqual(['a', 'd1', 'd2']);
  });

  it('says when done todos could not be read and lets the reader try again', async () => {
    const onLoadDone = vi
      .fn()
      .mockRejectedValueOnce(new Error('Not connected'))
      .mockResolvedValueOnce({ ok: false, reason: 'not_found: no such ask.' });
    const app = render(
      <NeoAskTodos
        entry={entry({ todos: [todo('a')], doneCount: 3 })}
        onAnswer={vi.fn()}
        onLoadDone={onLoadDone}
      />
    );
    fireEvent.click(app.getByRole('button', { name: '3 done — show more' }));
    await waitFor(() =>
      expect(app.getByRole('alert').textContent).toBe('Couldn’t load the done todos.')
    );
    fireEvent.click(app.getByRole('button', { name: '3 done — show more' }));
    await waitFor(() =>
      expect(app.getByRole('alert').textContent).toBe(
        'Couldn’t load the done todos: not_found: no such ask.'
      )
    );
    expect(rows(app)).toEqual(['a']);
  });

  it('pages done todos the snapshot left out through neo.ask.doneTodos', async () => {
    const onLoadDone = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        todos: [done('d1'), done('d2')],
        doneCount: 3,
        nextOffset: 2,
      })
      .mockResolvedValueOnce({ ok: true, todos: [done('d3')], doneCount: 3, nextOffset: null });
    const app = render(
      <NeoAskTodos
        entry={entry({ todos: [todo('a')], doneCount: 3 })}
        onAnswer={vi.fn()}
        onLoadDone={onLoadDone}
      />
    );
    fireEvent.click(app.getByRole('button', { name: '3 done — show more' }));
    await waitFor(() => expect(rows(app)).toEqual(['a', 'd1', 'd2']));
    expect(onLoadDone).toHaveBeenLastCalledWith('ask', 0);
    fireEvent.click(app.getByRole('button', { name: '1 done — show more' }));
    await waitFor(() => expect(rows(app)).toEqual(['a', 'd1', 'd2', 'd3']));
    expect(onLoadDone).toHaveBeenLastCalledWith('ask', 2);
    expect(app.queryByRole('button', { name: /done — show more/ })).toBeNull();
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

it('shows adapter-based worker identity and the next record name after rename', () => {
  const data = entry({ todos: [todo('a')] });
  const worker = {
    id: 'thread-1',
    adapter: 'codex-desktop',
    name: 'Claude something',
    label: 'Codex · Claude something',
  };
  Object.assign(data.todos[0], { worker });
  const app = render(<NeoAskTodos entry={data} onAnswer={vi.fn()} />);
  expect(app.getByText('Codex · Claude something')).toBeTruthy();
  app.rerender(
    <NeoAskTodos
      entry={{
        ...data,
        todos: [
          Object.assign(
            { ...data.todos[0] },
            { worker: { ...worker, name: 'renamed', label: 'Codex · renamed' } }
          ),
        ],
      }}
      onAnswer={vi.fn()}
    />
  );
  expect(app.getByText('Codex · renamed')).toBeTruthy();
  expect(app.queryByText('Codex · Claude something')).toBeNull();
});
