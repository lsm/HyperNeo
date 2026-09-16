import { describe, expect, test } from 'bun:test';
import {
  ApproveTaskSchema,
  MarkCompleteSchema,
  SubmitForApprovalSchema,
} from '../../../../src/lib/space/actions/task-agent-schemas.ts';

describe('ApproveTaskSchema', () => {
  test('accepts empty object', () => {
    const result = ApproveTaskSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('rejects extra fields (strict schema)', () => {
    const result = ApproveTaskSchema.safeParse({ reason: 'done' });
    expect(result.success).toBe(false);
  });

  test('schema description encodes Terminal Action pre-conditions (Task #136)', () => {
    const description = (ApproveTaskSchema as unknown as { description?: string }).description;
    expect(description).toBeDefined();
    expect(description).toMatch(/TERMINAL/i);
    expect(description).toMatch(/APPROVE/);
    expect(description).toContain('P0–P2');
  });
});

describe('SubmitForApprovalSchema', () => {
  test('accepts empty object (reason is optional)', () => {
    const result = SubmitForApprovalSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBeUndefined();
    }
  });

  test('accepts reason string', () => {
    const result = SubmitForApprovalSchema.safeParse({
      reason: 'Risky change, needs human review',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reason).toBe('Risky change, needs human review');
    }
  });

  test('rejects non-string reason', () => {
    const result = SubmitForApprovalSchema.safeParse({ reason: 42 });
    expect(result.success).toBe(false);
  });

  test('rejects extra fields (strict schema)', () => {
    const result = SubmitForApprovalSchema.safeParse({ reason: 'ok', extra: 'bad' });
    expect(result.success).toBe(false);
  });

  test('schema description equates submit_for_approval with approve_task (Task #136)', () => {
    const description = (SubmitForApprovalSchema as unknown as { description?: string })
      .description;
    expect(description).toBeDefined();
    expect(description).toMatch(/TERMINAL/i);
    expect(description).toMatch(/approve_task/);
    expect(description).toContain('P0–P2');
    expect(description).toMatch(/APPROVE/);
    expect(description).toMatch(/defer judgment|request changes/i);
  });
});

describe('MarkCompleteSchema', () => {
  test('accepts empty object', () => {
    const result = MarkCompleteSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('accepts rolling goal_update fields', () => {
    const result = MarkCompleteSchema.safeParse({
      goal_update: {
        summary: 'Shipped first milestone',
        progress: 50,
        metrics: { activated: 12, healthy: true, note: 'ok', stale: null },
        nextSteps: ['Measure adoption'],
      },
    });
    expect(result.success).toBe(true);
  });

  test('rejects extra fields (strict schema)', () => {
    const result = MarkCompleteSchema.safeParse({ reason: 'done' });
    expect(result.success).toBe(false);
  });

  test('rejects invalid goal_update payloads', () => {
    expect(MarkCompleteSchema.safeParse({ goal_update: { progress: 101 } }).success).toBe(false);
    expect(MarkCompleteSchema.safeParse({ goal_update: { status: 'completed' } }).success).toBe(
      false
    );
  });

  test('rejects non-object input', () => {
    const result = MarkCompleteSchema.safeParse('done');
    expect(result.success).toBe(false);
  });
});
