import { describe, expect, it } from 'vitest';
import { GOAL_STATUS_CONFIG, getGoalStatusClasses, getGoalStatusConfig } from './goal-status.js';

describe('goal-status', () => {
  it('covers every SpaceGoalStatus value', () => {
    const statuses: Array<keyof typeof GOAL_STATUS_CONFIG> = [
      'active',
      'paused',
      'completed',
      'archived',
    ];
    for (const status of statuses) {
      expect(GOAL_STATUS_CONFIG[status]).toBeDefined();
    }
  });

  it('maps active to success', () => {
    expect(GOAL_STATUS_CONFIG.active.tone).toBe('success');
    expect(GOAL_STATUS_CONFIG.active.label).toBe('Active');
  });

  it('maps paused to warning', () => {
    expect(GOAL_STATUS_CONFIG.paused.tone).toBe('warning');
    expect(GOAL_STATUS_CONFIG.paused.label).toBe('Paused');
  });

  it('maps completed to info', () => {
    expect(GOAL_STATUS_CONFIG.completed.tone).toBe('info');
    expect(GOAL_STATUS_CONFIG.completed.label).toBe('Completed');
  });

  it('maps archived to neutral', () => {
    expect(GOAL_STATUS_CONFIG.archived.tone).toBe('neutral');
    expect(GOAL_STATUS_CONFIG.archived.label).toBe('Archived');
  });

  it('returns tone classes from getGoalStatusClasses', () => {
    const classes = getGoalStatusClasses('paused');
    expect(classes.bg).toBe('bg-warning');
  });

  it('getGoalStatusConfig returns the same config as the record', () => {
    expect(getGoalStatusConfig('active')).toBe(GOAL_STATUS_CONFIG.active);
  });
});
