import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/preact';
import { act } from 'preact/test-utils';
import { readFileSync } from 'node:fs';
import { URL as NodeURL } from 'node:url';
import type { NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { NeoActivity, neoActivityItems } from '../NeoActivity.tsx';
import { classifyNeoScene, projectNeoScenes, type NeoScene } from '../neo-scenes.ts';
import { projectNeoConcernBoard } from '../neo-concern-board.ts';

const concerns = [{ id: 'sources', title: 'Fictional sources' }];
const work = (id: string, status: NeoWork['status'] = 'queued'): NeoWork => ({
  id,
  requestKey: id,
  concernId: 'sources',
  originSessionId: 'root',
  originMessageId: `ask-${id}`,
  title: `Compare ${id}`,
  instruction: 'Fictional comparison',
  status,
  report: null,
  sessionId: 'worker',
  createdAt: 1,
  updatedAt: 2,
});
const check = (id: string, status: NeoConsultation['status'] = 'pending'): NeoConsultation => ({
  id,
  requestKey: id,
  concernId: 'sources',
  originSessionId: 'root',
  originMessageId: `ask-${id}`,
  sessionId: 'holder',
  question: 'Which source is current?',
  status,
  answer: null,
  createdAt: 1,
});
const workScene = (id: string, status: NeoWork['status'] = 'queued') =>
  classifyNeoScene({ ...work(id, status), kind: 'work' });
const checkScene = (id: string) => classifyNeoScene({ ...check(id), kind: 'consultation' });
const mount = (scenes: readonly NeoScene[], enabled = true) =>
  render(<NeoActivity scenes={scenes} concerns={concerns} enabled={enabled} />);
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
  it.each(['proposed', 'reported', 'failed', 'cancelled'] as const)(
    'does not invent activity for %s work',
    (status) => {
      expect(neoActivityItems([workScene('one', status)], concerns)).toEqual([]);
    }
  );
  it('uses real projected receipt truth for work, context checks and queued checks', () => {
    const snapshot: NeoSnapshot = {
      ok: true,
      sessionId: 'root',
      concerns: [],
      work: [work('same-id')],
      consultations: [check('same-id')],
      consultationWaiters: [{ ...check('waiting'), originMessageId: 'original', status: 'queued' }],
    };
    const groups = projectNeoScenes(projectNeoConcernBoard(snapshot, null, null))!;
    const items = neoActivityItems(groups.running, concerns);
    expect(items).toHaveLength(3);
    expect(new Set(items.map((item) => item.key)).size).toBe(3);
    expect(items.map((item) => item.text)).toEqual(
      expect.arrayContaining([
        'Handed to HyperNeo · Compare same-id',
        'Checking context · Fictional sources',
        'Waiting for context · Fictional sources',
      ])
    );
    expect(items.some((item) => /complete|working|verified/i.test(item.text))).toBe(false);
  });
  it('uses safe fallback labels without exposing internal ids or summaries', () => {
    const empty = classifyNeoScene({ ...work('private-id'), title: '', kind: 'work' });
    const items = neoActivityItems([empty, checkScene('internal-check')], []);
    expect(items.map((item) => item.text)).toEqual([
      'Handed to HyperNeo · Work',
      'Checking context · Your context holder',
    ]);
  });
  it('preserves all receipts and input objects for long lists', () => {
    const scenes = Array.from({ length: 120 }, (_, index) => workScene(String(index)));
    const before = structuredClone(scenes);
    expect(neoActivityItems(scenes, concerns)).toHaveLength(120);
    expect(scenes).toEqual(before);
  });
});

describe('NeoActivity', () => {
  it('shows a quiet non-action line with the full text available when truncated', () => {
    const result = mount([workScene('one')]);
    const line = screen.getByRole('note', { name: 'Neo activity' });
    expect(line.getAttribute('aria-live')).toBe('off');
    expect(line.textContent).toContain('Handed to HyperNeo · Compare one');
    expect(result.container.querySelector('[title]')?.getAttribute('title')).toBe(
      'Handed to HyperNeo · Compare one'
    );
    expect(result.container.querySelectorAll('button, a, input')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rotates stable scene identities without taking focus from a draft', () => {
    const result = render(
      <>
        <textarea aria-label="Draft" defaultValue="Keep this draft" />
        <NeoActivity scenes={[workScene('one'), checkScene('two')]} concerns={concerns} enabled />
      </>
    );
    const draft = screen.getByRole('textbox', { name: 'Draft' }) as HTMLTextAreaElement;
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
  it('anchors the visible item by kind/id when order and titles change', () => {
    const one = workScene('same');
    const two = checkScene('same');
    const result = mount([one, two]);
    rotate();
    result.rerender(
      <NeoActivity
        scenes={[two, one]}
        concerns={[{ id: 'sources', title: 'Corrected sources' }]}
        enabled
      />
    );
    expect(screen.getByRole('note').textContent).toContain('Checking context · Corrected sources');
    expect(screen.getByRole('note').textContent).toContain('1/2');
    expect(vi.getTimerCount()).toBe(1);
  });
  it('removes stale activity immediately on terminal status and cancels its rotation', () => {
    const result = mount([workScene('one'), checkScene('two')]);
    rotate();
    result.rerender(
      <NeoActivity
        scenes={[workScene('one', 'reported'), workScene('remaining')]}
        concerns={concerns}
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
        scenes={[workScene('one'), checkScene('two')]}
        concerns={concerns}
        enabled
      />
    );
    rotate();
    result.rerender(
      <NeoActivity
        key="holder"
        scenes={[workScene('new-one'), workScene('new-two')]}
        concerns={concerns}
        enabled
      />
    );
    expect(screen.getByRole('note').textContent).toContain('Compare new-one');
    expect(screen.getByRole('note').textContent).toContain('1/2');
    expect(vi.getTimerCount()).toBe(1);
  });
  it('suppresses stale disconnected evidence and reserves an empty line without an announcement', () => {
    const result = mount([workScene('one'), checkScene('two')]);
    result.rerender(
      <NeoActivity
        scenes={[workScene('one'), checkScene('two')]}
        concerns={concerns}
        enabled={false}
      />
    );
    expect(screen.queryByRole('note')).toBeNull();
    expect(result.container.querySelector('.neo-activity')?.hasAttribute('hidden')).toBe(true);
    expect(result.container.textContent).toBe('');
    expect(vi.getTimerCount()).toBe(0);
    result.rerender(<NeoActivity scenes={[]} concerns={concerns} enabled />);
    expect(result.container.querySelector('.neo-activity')).not.toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });
  it('does not rotate in a background tab and resumes without a burst', () => {
    mount([workScene('one'), checkScene('two')]);
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
    expect(css).toMatch(/\.neo-activity\[hidden\]\s*\{[^}]*visibility:\s*hidden;/s);
    expect(css).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{\s*@supports\s*\(background-clip:\s*text\)\s*\{\s*\.neo-activity-text\s*\{[^}]*animation:\s*neo-activity-sweep/s
    );
    expect(css).not.toContain('--color-fg');
  });
});
