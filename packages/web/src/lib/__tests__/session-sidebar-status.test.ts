import { describe, expect, it } from 'vitest';
import {
  conversationTitle,
  getSessionSidebarStatus,
  getTaskSidebarStatus,
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

describe('getTaskSidebarStatus', () => {
  const thinking = {
    status: 'active',
    processingState: { status: 'processing', phase: 'thinking' },
  };
  const waiting = { status: 'active', processingState: { status: 'waiting_for_input' } };
  const interrupted = { status: 'active', processingState: { status: 'interrupted' } };

  it('prioritizes a worker waiting for input over running work', () => {
    expect(getTaskSidebarStatus({ status: 'in_progress' }, [thinking, waiting]).label).toBe(
      'Waiting for input'
    );
  });

  it('prefers current running work to interrupted historical workers', () => {
    expect(getTaskSidebarStatus({ status: 'in_progress' }, [interrupted, thinking]).label).toBe(
      'Thinking'
    );
  });

  it('keeps completed and review task state authoritative', () => {
    expect(getTaskSidebarStatus({ status: 'done' }, [thinking]).label).toBe('Done');
    expect(getTaskSidebarStatus({ status: 'review' }, [interrupted]).label).toBe('Awaiting Review');
  });

  it('uses task lifecycle if no session is running', () => {
    expect(getTaskSidebarStatus({ status: 'blocked' }, [{ status: 'active' }]).label).toBe(
      'Blocked'
    );
    expect(getTaskSidebarStatus({ status: 'draft' }, []).label).toBe('Draft');
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
