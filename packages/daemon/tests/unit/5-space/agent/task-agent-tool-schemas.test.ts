import { describe, expect, test } from 'bun:test';
import {
  ApproveTaskSchema,
  ListGroupMembersSchema,
  MarkCompleteSchema,
  RequestHumanInputSchema,
  SubmitForApprovalSchema,
  UpdateTaskSchema,
  TASK_AGENT_TOOL_SCHEMAS,
} from '../../../../src/lib/space/tools/task-agent-tool-schemas.ts';

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

describe('RequestHumanInputSchema', () => {
  test('accepts valid input with question only', () => {
    const result = RequestHumanInputSchema.safeParse({ question: 'Should I proceed?' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.question).toBe('Should I proceed?');
      expect(result.data.context).toBeUndefined();
    }
  });

  test('accepts valid input with question and context', () => {
    const result = RequestHumanInputSchema.safeParse({
      question: 'Which environment should I deploy to?',
      context: 'The staging build passed all tests.',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context).toBe('The staging build passed all tests.');
    }
  });

  test('rejects missing question', () => {
    const result = RequestHumanInputSchema.safeParse({ context: 'some context' });
    expect(result.success).toBe(false);
  });

  test('rejects non-string question', () => {
    const result = RequestHumanInputSchema.safeParse({ question: 123 });
    expect(result.success).toBe(false);
  });

  test('rejects non-string context', () => {
    const result = RequestHumanInputSchema.safeParse({ question: 'ok?', context: false });
    expect(result.success).toBe(false);
  });

  test('rejects empty object', () => {
    const result = RequestHumanInputSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe('UpdateTaskSchema', () => {
  test('accepts an optional status', () => {
    const result = UpdateTaskSchema.safeParse({ task_id: 't1', status: 'cancelled' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe('cancelled');
    }
  });

  test('status stays optional', () => {
    const result = UpdateTaskSchema.safeParse({ task_id: 't1', title: 'T' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBeUndefined();
    }
  });

  test('rejects unknown status values', () => {
    expect(UpdateTaskSchema.safeParse({ task_id: 't1', status: 'paused' }).success).toBe(false);
  });

  test('status description documents the review/approved restrictions', () => {
    const description = UpdateTaskSchema.shape.status.description ?? '';
    expect(description).toContain('submit_for_approval');
    expect(description).toContain('approved');
    expect(description).toContain('review→done');
    expect(description).toContain('stopped');
  });
});

describe('TASK_AGENT_TOOL_SCHEMAS', () => {
  test('contains all 6 tool schemas', () => {
    const keys = Object.keys(TASK_AGENT_TOOL_SCHEMAS);
    expect(keys).toContain('approve_task');
    expect(keys).toContain('submit_for_approval');
    expect(keys).toContain('request_human_input');
    expect(keys).toContain('list_group_members');
    expect(keys).toContain('mark_complete');
    expect(keys).toContain('update_task');
    expect(keys).toHaveLength(6);
  });

  test('each schema value is a valid Zod schema with safeParse', () => {
    for (const schema of Object.values(TASK_AGENT_TOOL_SCHEMAS)) {
      expect(typeof schema.safeParse).toBe('function');
    }
  });

  test('does not contain removed tools', () => {
    const keys = Object.keys(TASK_AGENT_TOOL_SCHEMAS);
    expect(keys).not.toContain('spawn_node_agent');
    expect(keys).not.toContain('check_node_status');
    expect(keys).not.toContain('advance_workflow');
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

describe('ListGroupMembersSchema', () => {
  test('accepts empty object', () => {
    const result = ListGroupMembersSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test('accepts object with extra fields (passthrough)', () => {
    const result = ListGroupMembersSchema.safeParse({ extra: 'ignored' });
    expect(result.success).toBe(true);
  });
});
