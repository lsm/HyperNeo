import { describe, expect, it } from 'vitest';
import { getTaskSidebarStatus } from '../space-task-sidebar-status.ts';

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
    expect(getTaskSidebarStatus({ status: 'review' }, [interrupted]).label).toBe('Review');
  });

  it('uses task lifecycle if no session is running', () => {
    expect(getTaskSidebarStatus({ status: 'blocked' }, [{ status: 'active' }]).label).toBe(
      'Blocked'
    );
    expect(getTaskSidebarStatus({ status: 'draft' }, []).label).toBe('Draft');
  });

  it.each(['blocked', 'rate_limited', 'usage_limited'] as const)(
    'keeps attention state %s ahead of a running worker',
    (status) => {
      expect(getTaskSidebarStatus({ status }, [thinking]).kind).toBe(status);
    }
  );
});
