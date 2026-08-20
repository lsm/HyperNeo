import { describe, expect, it } from 'vitest';
import { getTaskStatusClasses, getTaskStatusConfig, TASK_STATUS_CONFIG } from './task-status.js';

describe('task-status', () => {
  it('covers every SpaceTaskStatus value', () => {
    const statuses: Array<keyof typeof TASK_STATUS_CONFIG> = [
      'draft',
      'open',
      'in_progress',
      'review',
      'approved',
      'done',
      'blocked',
      'cancelled',
      'archived',
      'stopped',
    ];
    for (const status of statuses) {
      expect(TASK_STATUS_CONFIG[status]).toBeDefined();
    }
  });

  it('maps blocked to danger', () => {
    expect(TASK_STATUS_CONFIG.blocked.tone).toBe('danger');
    expect(TASK_STATUS_CONFIG.blocked.label).toBe('Blocked');
  });

  it('maps review to special', () => {
    expect(TASK_STATUS_CONFIG.review.tone).toBe('special');
    expect(TASK_STATUS_CONFIG.review.label).toBe('Awaiting Review');
  });

  it('maps in_progress to info', () => {
    expect(TASK_STATUS_CONFIG.in_progress.tone).toBe('info');
    expect(TASK_STATUS_CONFIG.in_progress.label).toBe('In Progress');
  });

  it('maps approved and done to success', () => {
    expect(TASK_STATUS_CONFIG.approved.tone).toBe('success');
    expect(TASK_STATUS_CONFIG.done.tone).toBe('success');
  });

  it('maps draft, open, cancelled, and archived to neutral', () => {
    expect(TASK_STATUS_CONFIG.draft.tone).toBe('neutral');
    expect(TASK_STATUS_CONFIG.open.tone).toBe('neutral');
    expect(TASK_STATUS_CONFIG.cancelled.tone).toBe('neutral');
    expect(TASK_STATUS_CONFIG.archived.tone).toBe('neutral');
  });

  it('maps stopped to neutral, distinct from in_progress and rate limited', () => {
    expect(TASK_STATUS_CONFIG.stopped.tone).toBe('neutral');
    expect(TASK_STATUS_CONFIG.stopped.label).toBe('Stopped');
    expect(TASK_STATUS_CONFIG.stopped.tone).not.toBe(TASK_STATUS_CONFIG.in_progress.tone);
    expect(TASK_STATUS_CONFIG.stopped.tone).not.toBe(TASK_STATUS_CONFIG.rate_limited.tone);
  });

  it('returns tone classes from getTaskStatusClasses', () => {
    const classes = getTaskStatusClasses('done');
    expect(classes.bg).toBe('bg-green-500');
  });

  it('getTaskStatusConfig returns the same config as the record', () => {
    expect(getTaskStatusConfig('blocked')).toBe(TASK_STATUS_CONFIG.blocked);
  });
});
