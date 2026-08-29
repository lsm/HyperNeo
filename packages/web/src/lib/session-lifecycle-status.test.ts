import { describe, expect, it } from 'vitest';
import {
  getSessionLifecycleStatusClasses,
  getSessionLifecycleStatusConfig,
  SESSION_LIFECYCLE_STATUS_CONFIG,
} from './session-lifecycle-status.js';

describe('session-lifecycle-status', () => {
  it('maps active to success', () => {
    expect(SESSION_LIFECYCLE_STATUS_CONFIG.active.tone).toBe('success');
    expect(SESSION_LIFECYCLE_STATUS_CONFIG.active.label).toBe('Active');
  });

  it('maps pending_worktree_choice to progress', () => {
    expect(SESSION_LIFECYCLE_STATUS_CONFIG.pending_worktree_choice.tone).toBe('progress');
    expect(SESSION_LIFECYCLE_STATUS_CONFIG.pending_worktree_choice.label).toBe('Pending');
  });

  it('maps paused to warning', () => {
    expect(SESSION_LIFECYCLE_STATUS_CONFIG.paused.tone).toBe('warning');
    expect(SESSION_LIFECYCLE_STATUS_CONFIG.paused.label).toBe('Paused');
  });

  it('maps ended to neutral', () => {
    expect(SESSION_LIFECYCLE_STATUS_CONFIG.ended.tone).toBe('neutral');
    expect(SESSION_LIFECYCLE_STATUS_CONFIG.ended.label).toBe('Ended');
  });

  it('maps archived to neutral', () => {
    expect(SESSION_LIFECYCLE_STATUS_CONFIG.archived.tone).toBe('neutral');
    expect(SESSION_LIFECYCLE_STATUS_CONFIG.archived.label).toBe('Archived');
  });

  it('returns tone classes from getSessionLifecycleStatusClasses', () => {
    const classes = getSessionLifecycleStatusClasses('paused');
    expect(classes.bg).toBe('bg-warning');
  });

  it('getSessionLifecycleStatusConfig returns the same config as the record', () => {
    expect(getSessionLifecycleStatusConfig('active')).toBe(SESSION_LIFECYCLE_STATUS_CONFIG.active);
  });
});
