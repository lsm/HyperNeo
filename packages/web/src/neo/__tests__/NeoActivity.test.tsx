import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { act } from 'preact/test-utils';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import type { NeoConsultation } from '@hyperneo/shared/types/neo-context';
import type { NeoTodoEntry } from '@hyperneo/shared/types/neo-ask';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { NeoActivity, neoActivityItems } from '../NeoActivity.tsx';
import { NeoBusyRow } from '../NeoBusyRow.tsx';
import { NEO_BUSY_WORDS } from '../processing-activity.ts';
import { testAskEntry, testTodo } from './neo-test-views.ts';

const projects = [{ id: 'sources', title: 'Fictional sources' }];
type Item = { todo: NeoTodoEntry } | { check: NeoConsultation };
const todo = (
  id: string,
  state: NeoTodoEntry['state'] = 'doing',
  title = `Compare ${id}`
): Item => ({
  todo: testTodo(id, { state, title, status: state === 'doing' ? '在做' : '做完了' }),
});
const check = (id: string, status: NeoConsultation['status'] = 'pending'): Item => ({
  check: {
    id,
    requestKey: id,
    projectId: 'sources',
    originSessionId: 'root',
    originMessageId: `ask-${id}`,
    sessionId: 'holder',
    question: 'Which source is current?',
    status,
    answer: null,
    createdAt: 1,
  },
});
const view = (...items: Item[]) =>
  ({
    todoAsks: [
      testAskEntry('ask', 'Ask', {
        todos: items.flatMap((item) => ('todo' in item ? [item.todo] : [])),
      }),
    ],
    consultations: items.flatMap((item) => ('check' in item ? [item.check] : [])),
    consultationWaiters: [],
  }) as unknown as NeoSnapshot;
const mount = (snapshot: NeoSnapshot, enabled = true) =>
  render(<NeoActivity snapshot={snapshot} projects={projects} enabled={enabled} />);
const rotate = () =>
  act(() => {
    vi.advanceTimersByTime(6000);
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('neoActivityItems', () => {
  it.each(['todo', 'done', 'failed', 'removed'] as const)(
    'does not invent activity for a %s todo',
    (state) => {
      expect(neoActivityItems(view(todo('one', state)), projects)).toEqual([]);
    }
  );
  it('lists doing todos, pending context checks and queued checks', () => {
    const snapshot = {
      ...view(todo('same-id'), check('same-id'), check('done', 'reported')),
      consultationWaiters: [{ id: 'waiting', projectId: 'sources', status: 'queued' }],
    } as unknown as NeoSnapshot;
    const items = neoActivityItems(snapshot, projects);
    expect(new Set(items.map((item) => item.key)).size).toBe(3);
    expect(items.map((item) => item.text)).toEqual([
      '在做 · Compare same-id',
      'Checking context · Fictional sources',
      'Waiting for context · Fictional sources',
    ]);
  });
  it('names an unknown holder without exposing its id', () => {
    expect(neoActivityItems(view(check('internal-check')), []).map((item) => item.text)).toEqual([
      'Checking context · Your context holder',
    ]);
  });
  it('keeps every doing todo for long lists', () => {
    const items = Array.from({ length: 120 }, (_, index) => todo(String(index)));
    expect(neoActivityItems(view(...items), projects)).toHaveLength(120);
  });
});

describe('NeoActivity', () => {
  it('shows a quiet non-action line with the full text available when truncated', () => {
    const result = mount(view(todo('one')));
    const line = screen.getByRole('note', { name: 'Neo activity' });
    expect(line.getAttribute('aria-live')).toBe('off');
    expect(line.textContent).toContain('在做 · Compare one');
    expect(result.container.querySelector('[title]')?.getAttribute('title')).toBe(
      '在做 · Compare one'
    );
    expect(result.container.querySelectorAll('button, a, input')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rotates stable scene identities without taking focus from a draft', () => {
    const result = render(
      <>
        <textarea aria-label="Draft" defaultValue="Keep this draft" />
        <NeoActivity snapshot={view(todo('one'), check('two'))} projects={projects} enabled />
      </>
    );
    const draft = screen.getByRole('textbox', {
      name: 'Draft',
    }) as HTMLTextAreaElement;
    draft.focus();
    draft.setSelectionRange(5, 9);
    expect(screen.getByRole('note').textContent).toContain('1/2');
    rotate();
    expect(screen.getByRole('note').textContent).toContain('Checking context · Fictional sources');
    expect(screen.getByRole('note').textContent).toContain('2/2');
    expect(document.activeElement).toBe(draft);
    expect([draft.value, draft.selectionStart, draft.selectionEnd]).toEqual([
      'Keep this draft',
      5,
      9,
    ]);
    rotate();
    expect(screen.getByRole('note').textContent).toContain('Compare one');
    result.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('anchors the visible item by kind/id when titles change', () => {
    const result = mount(view(todo('same'), check('same')));
    rotate();
    result.rerender(
      <NeoActivity
        snapshot={view(todo('same', 'doing', 'Renamed'), check('same'))}
        projects={[{ id: 'sources', title: 'Corrected sources' }]}
        enabled
      />
    );
    expect(screen.getByRole('note').textContent).toContain('Checking context · Corrected sources');
    expect(screen.getByRole('note').textContent).toContain('2/2');
    expect(vi.getTimerCount()).toBe(1);
  });
  it('removes stale activity immediately on terminal status and cancels its rotation', () => {
    const result = mount(view(todo('one'), check('two')));
    rotate();
    result.rerender(
      <NeoActivity
        snapshot={view(todo('one', 'done'), todo('remaining'))}
        projects={projects}
        enabled
      />
    );
    expect(screen.getByRole('note').textContent).toContain('Compare remaining');
    expect(screen.getByRole('note').textContent).not.toContain('Checking context');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clears stale scope state when its owning conversation changes', () => {
    const result = render(
      <NeoActivity
        key="root"
        snapshot={view(todo('one'), check('two'))}
        projects={projects}
        enabled
      />
    );
    rotate();
    result.rerender(
      <NeoActivity
        key="holder"
        snapshot={view(todo('new-one'), todo('new-two'))}
        projects={projects}
        enabled
      />
    );
    expect(screen.getByRole('note').textContent).toContain('Compare new-one');
    expect(screen.getByRole('note').textContent).toContain('1/2');
    expect(vi.getTimerCount()).toBe(1);
  });
  it('suppresses stale disconnected evidence and reserves an empty line without an announcement', () => {
    const result = mount(view(todo('one'), check('two')));
    result.rerender(
      <NeoActivity snapshot={view(todo('one'), check('two'))} projects={projects} enabled={false} />
    );
    expect(screen.queryByRole('note')).toBeNull();
    expect(result.container.querySelector('.neo-activity')?.hasAttribute('hidden')).toBe(true);
    expect(result.container.textContent).toBe('');
    expect(vi.getTimerCount()).toBe(0);
    result.rerender(<NeoActivity snapshot={view()} projects={projects} enabled />);
    expect(result.container.querySelector('.neo-activity')).not.toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });
  it('does not rotate in a background tab and resumes without a burst', () => {
    mount(view(todo('one'), check('two')));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => {
      vi.advanceTimersByTime(18000);
    });
    expect(screen.getByRole('note').textContent).toContain('Compare one');
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    rotate();
    expect(screen.getByRole('note').textContent).toContain('Checking context');
  });
  it('scopes the soft shimmer to supported normal-motion styling with readable theme fallbacks', () => {
    const css = readFileSync(new NodeURL('../neo.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.neo-activity\s*\{[^}]*height:\s*28px;[^}]*color:\s*var\(--fg-muted\);/s);
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{\s*@supports\s*\(background-clip:\s*text\)\s*\{\s*\.neo-activity-text\s*\{[^}]*animation:\s*neo-activity-sweep/s
    );
    expect(css).not.toContain('--color-fg');
  });
  it('sits inside the composer above a divider and takes no space when idle', () => {
    const css = readFileSync(new NodeURL('../neo.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.neo-activity\s*\{[^}]*border-bottom:\s*1px solid var\(--line\);/s);
    expect(css).toMatch(/\.neo-activity\[hidden\]\s*\{[^}]*display:\s*none;/s);
  });
});

describe('NeoBusyRow', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it('cycles the busy words every three seconds beside the dots', () => {
    const result = render(<NeoBusyRow words={NEO_BUSY_WORDS} />);
    const row = screen.getByRole('status');
    expect(row.textContent).toBe('Neo is working…');
    expect(result.container.querySelectorAll('.neo-progress-dots i')).toHaveLength(3);
    expect(row.getAttribute('aria-live')).toBe('off');
    expect(row.getAttribute('aria-label')).toBe('Neo is working…');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(row.textContent).toBe('Syncing…');
  });
  it('holds a single word without a timer', () => {
    render(<NeoBusyRow words={['Waiting to retry…']} />);
    expect(screen.getByRole('status').textContent).toBe('Waiting to retry…');
    expect(vi.getTimerCount()).toBe(0);
  });
});
