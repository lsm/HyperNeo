import { describe, expect, it } from 'vitest';
import { reminderLabel, toReminderCounts } from '../agent-reminder-counts';

describe('toReminderCounts', () => {
  it('keeps an entry whose agent id is __proto__', () => {
    const counts = toReminderCounts(JSON.parse('{"__proto__": 3, "a": 1}'));

    expect(counts.get('__proto__')).toBe(3);
    expect(counts.get('a')).toBe(1);
  });

  it('is empty for an empty record', () => {
    expect(toReminderCounts({}).size).toBe(0);
  });
});

describe('reminderLabel', () => {
  it('singularises one reminder', () => {
    expect(reminderLabel(1)).toBe('1 reminder');
  });

  it('pluralises more than one', () => {
    expect(reminderLabel(4)).toBe('4 reminders');
  });

  it('returns null when there is nothing to show', () => {
    expect(reminderLabel(0)).toBeNull();
    expect(reminderLabel(undefined)).toBeNull();
  });
});
