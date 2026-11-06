import { describe, expect, it } from 'vitest';
import {
  cloneConversationTitles,
  conversationTitle,
  getSessionSidebarStatus,
} from '../session-sidebar-status.ts';

describe('getSessionSidebarStatus', () => {
  it.each([
    ['idle', undefined, 'Idle', 'neutral', false],
    ['queued', undefined, 'Queued', 'progress', false],
    ['processing', 'initializing', 'Initializing', 'progress', true],
    ['processing', 'thinking', 'Thinking', 'info', true],
    ['processing', 'streaming', 'Streaming', 'success', true],
    ['processing', 'finalizing', 'Finalizing', 'special', true],
    ['processing', undefined, 'Processing', 'info', true],
    ['waiting_for_input', undefined, 'Waiting for input', 'warning', false],
    ['rate_limit_cooldown', undefined, 'Rate Limited', 'warning', false],
    ['interrupted', undefined, 'Interrupted', 'danger', false],
    ['error', undefined, 'Error', 'danger', false],
  ])('represents %s / %s without hiding unread', (status, phase, label, tone, pulse) => {
    expect(
      getSessionSidebarStatus({
        status: 'active',
        processingState: JSON.stringify({ status, phase }),
      })
    ).toMatchObject({ label, tone, pulse });
  });

  it.each([
    ['paused', 'Paused'],
    ['ended', 'Ended'],
    ['archived', 'Archived'],
    ['pending_worktree_choice', 'Needs worktree choice'],
  ])('gives lifecycle %s precedence over stale processing', (status, label) => {
    expect(
      getSessionSidebarStatus({ status, processingState: { status: 'processing' } })
    ).toMatchObject({ label, pulse: false });
  });

  it.each([undefined, null, 'null', '[]', 'malformed', 5, { status: 'unknown' }])(
    'handles an invalid state %s',
    (processingState) => {
      expect(getSessionSidebarStatus({ status: 'active', processingState }).label).toBe('Idle');
    }
  );

  it('distinguishes an unstarted agent from an idle session', () => {
    expect(getSessionSidebarStatus(null).label).toBe('Not started');
    expect(getSessionSidebarStatus({ status: 'active' }).label).toBe('Idle');
  });
});

describe('conversationTitle', () => {
  it('removes only a clone suffix, preserving custom titles and ordinals', () => {
    expect(conversationTitle('Review · 分身', true)).toBe('Review');
    expect(conversationTitle('Review · 分身 2', true)).toBe('Review 2');
    expect(conversationTitle('Discuss 分身 design', true)).toBe('Discuss 分身 design');
    expect(conversationTitle('Review · 分身', false)).toBe('Review · 分身');
  });
});

describe('cloneConversationTitles', () => {
  it('numbers clones whose stripped title collides with the parent', () => {
    const clones = [
      { id: 'c1', title: 'Research · 分身' },
      { id: 'c2', title: 'Research · 分身' },
      { id: 'c3', title: 'Research · 分身' },
    ];
    expect([...cloneConversationTitles('Research', clones).values()]).toEqual([
      'Research 2',
      'Research 3',
      'Research 4',
    ]);
  });

  it('leaves clones with distinct titles untouched', () => {
    const clones = [
      { id: 'c1', title: 'Follow-up · 分身' },
      { id: 'c2', title: 'Deep dive · 分身' },
    ];
    const titles = cloneConversationTitles('Research', clones);
    expect(titles.get('c1')).toBe('Follow-up');
    expect(titles.get('c2')).toBe('Deep dive');
  });

  it('returns an empty map for no clones', () => {
    expect(cloneConversationTitles('Research', []).size).toBe(0);
  });
});
