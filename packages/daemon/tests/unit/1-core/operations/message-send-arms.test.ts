import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { createSendMessageOperation } from '../../../../src/lib/messaging/message-send';
import { createNodeSendMessageOperation } from '../../../../src/lib/messaging/node-send-message';
import {
  SendSessionMessageInputSchema,
  SendSessionMessageResultSchema,
} from '../../../../src/lib/messaging/session-message-send';
import {
  TaskMessageSendInputSchema,
  TaskMessageSendResultSchema,
} from '../../../../src/lib/messaging/task-message-send';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import {
  createOperationRegistry,
  defineOperation,
  type OperationDefinition,
} from '../../../../src/lib/operations/registry';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

interface RecordingArm {
  definition: OperationDefinition;
  received: unknown[];
}

function recordingArm(
  name: string,
  inputSchema: z.ZodType<unknown>,
  resultSchema: z.ZodType<unknown>,
  result: unknown
): RecordingArm {
  const received: unknown[] = [];
  return {
    received,
    definition: defineOperation({
      name,
      description: `stand-in for ${name}`,
      inputSchema,
      resultSchema,
      execute: (input) => {
        received.push(input);
        return Promise.resolve(result);
      },
    }),
  };
}

function spaceSessionArm(result: unknown): RecordingArm {
  return recordingArm(
    'session.message.send',
    SendSessionMessageInputSchema as z.ZodType<unknown>,
    SendSessionMessageResultSchema as z.ZodType<unknown>,
    result
  );
}

function taskArm(result: unknown): RecordingArm {
  return recordingArm(
    'task.message.send',
    TaskMessageSendInputSchema as z.ZodType<unknown>,
    TaskMessageSendResultSchema as z.ZodType<unknown>,
    result
  );
}

const unreachableNodeArm = createNodeSendMessageOperation({
  nodeExecutionRepo: {
    getByAgentSessionId: () => null,
    listByNode: () => [],
    listByWorkflowRun: () => [],
  },
  runtimeForSession: () => null,
});

describe('message.send recipient arms', () => {
  let mailbox: MailboxTestDb;
  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });
  afterEach(() => mailbox.close());

  function door(arms: Parameters<typeof createSendMessageOperation>[3]) {
    return createOperationRegistry([
      createSendMessageOperation(mailbox.jobQueue, () => true, undefined, arms),
    ]);
  }

  test('hands a spaceSession recipient to the ad-hoc session arm in its own shape', async () => {
    const arm = spaceSessionArm({ success: true, delivered: true, message_id: 'm-1' });
    const outcome = await invokeOperation(
      door({ spaceSession: arm.definition }),
      'message.send',
      {
        to: {
          kind: 'spaceSession',
          spaceId: 'space-1',
          sessionId: 'session-1',
          answerQuestion: true,
        },
        message: 'yes please',
      },
      { source: 'mcp', sessionId: 'agent-1' }
    );

    expect(arm.received).toEqual([
      {
        spaceId: 'space-1',
        sessionId: 'session-1',
        answerQuestion: true,
        message: 'yes please',
      },
    ]);
    expect(outcome).toEqual({
      kind: 'completed',
      value: { success: true, delivered: true, message_id: 'm-1' },
    });
    expect(mailbox.rowCount()).toBe(0);
  });

  test('hands a task recipient to the task arm and keeps its task_id on the way back', async () => {
    const arm = taskArm({ success: false, task_id: 'task-9', error: 'no such node' });
    const outcome = await invokeOperation(
      door({ task: arm.definition }),
      'message.send',
      {
        to: {
          kind: 'task',
          spaceId: 'space-1',
          taskNumber: 12,
          target: '@worker:run-1/node-1/reviewer',
          outboundSenderLevel: 'long-horizon-agent',
          outboundSenderDisplayName: 'task-manager',
        },
        message: 'status please',
      },
      { source: 'mcp', sessionId: 'agent-1' }
    );

    expect(arm.received).toEqual([
      {
        spaceId: 'space-1',
        taskNumber: 12,
        target: '@worker:run-1/node-1/reviewer',
        outboundSenderLevel: 'long-horizon-agent',
        outboundSenderDisplayName: 'task-manager',
        message: 'status please',
      },
    ]);
    expect(outcome).toEqual({
      kind: 'completed',
      value: { success: false, task_id: 'task-9', error: 'no such node' },
    });
  });

  test('keeps the node-agent gate when a peer recipient comes from a non-node session', async () => {
    const outcome = await invokeOperation(
      door({ peer: unreachableNodeArm }),
      'message.send',
      { to: { kind: 'peer', target: ['reviewer', 'qa'] }, message: 'handing off' },
      { source: 'mcp', sessionId: 'not-a-node', role: 'workflow_worker' }
    );

    expect(outcome).toEqual({ kind: 'completed', value: 'not_a_node_agent' });
    expect(mailbox.rowCount()).toBe(0);
  });

  test('denies a peer recipient from a caller the node door does not admit', async () => {
    const outcome = await invokeOperation(
      door({ peer: unreachableNodeArm }),
      'message.send',
      { to: { kind: 'peer', target: 'reviewer' }, message: 'handing off' },
      { source: 'mcp', sessionId: 'session-1', role: 'ad_hoc_member' }
    );

    expect(outcome).toEqual({ kind: 'completed', value: 'node_caller_denied' });
  });

  test('rejects a recipient this daemon has no arm for without touching the mailbox', async () => {
    const outcome = await invokeOperation(
      door({}),
      'message.send',
      {
        to: {
          kind: 'task',
          spaceId: 'space-1',
          taskId: 'task-1',
          outboundSenderLevel: 'node-agent',
          outboundSenderDisplayName: 'writer',
        },
        message: 'ping',
      },
      { source: 'mcp', sessionId: 'agent-1' }
    );

    expect(outcome).toEqual({
      kind: 'completed',
      value: {
        kind: 'rejected',
        reason: 'message.send cannot address a task recipient on this daemon',
      },
    });
    expect(mailbox.rowCount()).toBe(0);
  });

  test('still lands a session recipient in the mailbox with every arm wired', async () => {
    const outcome = await invokeOperation(
      door({
        spaceSession: spaceSessionArm({ success: true, delivered: true, message_id: 'm' })
          .definition,
        task: taskArm({ success: true, task_id: 't' }).definition,
        peer: unreachableNodeArm,
      }),
      'message.send',
      {
        to: { kind: 'session', sessionId: 'destination' },
        message: { type: 'user', message: { content: 'hello' }, parent_tool_use_id: null },
      },
      { source: 'rpc' }
    );

    expect(outcome).toMatchObject({ kind: 'completed', value: { kind: 'accepted' } });
    expect(mailbox.rowCount()).toBe(1);
  });
});
