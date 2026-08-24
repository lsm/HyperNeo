import { describe, expect, test } from 'bun:test';
import { GOAL_OUTCOME_WAKE_ENABLED } from '../../../../src/lib/space/runtime/goal-outcome-wake-flag';
import {
  LONG_HORIZON_OWNER_REVIEW_CONTRACT,
  LONG_HORIZON_SCHEDULING_GUARDRAIL,
} from '@hyperneo/prompts';

describe('MC2-C injection sequencing flip (MC5-B)', () => {
  test('goal outcome wake injection is enabled now that both sequencing halves are live', () => {
    expect(GOAL_OUTCOME_WAKE_ENABLED).toBe(true);
  });

  test('the prompt half of the sequencing condition teaches the live review tool', () => {
    expect(LONG_HORIZON_OWNER_REVIEW_CONTRACT).toContain('review_goal_outcome');
    expect(LONG_HORIZON_OWNER_REVIEW_CONTRACT).toContain('notification_id');
    expect(LONG_HORIZON_OWNER_REVIEW_CONTRACT.length).toBeGreaterThan(
      LONG_HORIZON_SCHEDULING_GUARDRAIL.length / 4
    );
  });
});
