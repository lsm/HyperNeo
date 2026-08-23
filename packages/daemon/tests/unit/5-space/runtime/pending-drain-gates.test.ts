import { describe, expect, test } from 'bun:test';
import {
  derivePendingQueueTargetNames,
  selectDrainablePendingRows,
} from '../../../../src/lib/space/runtime/pending-drain-gates';
import type { PendingAgentMessageRecord } from '../../../../src/storage/repositories/pending-agent-message-repository';

const AGENT_NAME = 'coder';
const NODE_NAME = 'Build';

function makeRow(overrides: Partial<PendingAgentMessageRecord> = {}): PendingAgentMessageRecord {
  return {
    id: 'row-1',
    workflowRunId: 'run-1',
    spaceId: 'space-1',
    taskId: null,
    sourceAgentName: 'reviewer',
    targetKind: 'node_agent',
    targetAgentName: AGENT_NAME,
    message: 'queued note',
    workflowNodeId: null,
    idempotencyKey: null,
    attempts: 0,
    maxAttempts: 5,
    lastAttemptAt: null,
    lastError: null,
    status: 'pending',
    deliveredAt: null,
    deliveredSessionId: null,
    expiresAt: Number.MAX_SAFE_INTEGER,
    createdAt: 1,
    deliveryMode: null,
    ...overrides,
  };
}

describe('derivePendingQueueTargetNames', () => {
  test('returns the bare agent name alone when the node name is unknown', () => {
    expect(derivePendingQueueTargetNames(AGENT_NAME, null)).toEqual([AGENT_NAME]);
  });

  test('appends the node/agent alias after the bare name when the node name is known', () => {
    expect(derivePendingQueueTargetNames(AGENT_NAME, NODE_NAME)).toEqual([
      AGENT_NAME,
      `${NODE_NAME}/${AGENT_NAME}`,
    ]);
  });
});

describe('selectDrainablePendingRows', () => {
  test('keeps only rows matching the drained targetKind', () => {
    const nodeRow = makeRow({ id: 'row-node', targetKind: 'node_agent' });
    const spaceRow = makeRow({ id: 'row-space', targetKind: 'space_agent' });

    const drained = selectDrainablePendingRows(
      [{ targetName: AGENT_NAME, rows: [nodeRow, spaceRow] }],
      {
        executionPresent: true,
        targetKind: 'node_agent',
      }
    );

    expect(drained).toEqual([nodeRow]);
  });

  test('executionless drain admits only run-scoped rows', () => {
    const runScoped = makeRow({ id: 'row-run', workflowNodeId: null });
    const nodeScoped = makeRow({ id: 'row-node', workflowNodeId: 'node-build' });

    const drained = selectDrainablePendingRows(
      [{ targetName: AGENT_NAME, rows: [runScoped, nodeScoped] }],
      {
        executionPresent: false,
        targetKind: 'node_agent',
      }
    );

    expect(drained).toEqual([runScoped]);
  });

  test('execution-bound drain keeps node-scoped rows alongside run-scoped rows', () => {
    const runScoped = makeRow({ id: 'row-run', workflowNodeId: null });
    const nodeScoped = makeRow({ id: 'row-node', workflowNodeId: 'node-build' });

    const drained = selectDrainablePendingRows(
      [{ targetName: AGENT_NAME, rows: [runScoped, nodeScoped] }],
      {
        executionPresent: true,
        targetKind: 'node_agent',
      }
    );

    expect(drained).toEqual([runScoped, nodeScoped]);
  });

  test('dedups rows returned by both the bare-name and alias listings, keeping the first occurrence', () => {
    const duplicate = makeRow({ id: 'row-dup' });

    const drained = selectDrainablePendingRows(
      [
        { targetName: AGENT_NAME, rows: [duplicate] },
        { targetName: `${NODE_NAME}/${AGENT_NAME}`, rows: [duplicate] },
      ],
      { executionPresent: true, targetKind: 'node_agent' }
    );

    expect(drained).toEqual([duplicate]);
  });

  test('re-sorts the merged listings by createdAt ascending', () => {
    const aliasRow = makeRow({ id: 'row-alias', createdAt: 1 });
    const lateRow = makeRow({ id: 'row-late', createdAt: 3 });
    const midRow = makeRow({ id: 'row-mid', createdAt: 2 });

    const drained = selectDrainablePendingRows(
      [
        { targetName: AGENT_NAME, rows: [lateRow, midRow] },
        { targetName: `${NODE_NAME}/${AGENT_NAME}`, rows: [aliasRow] },
      ],
      { executionPresent: true, targetKind: 'node_agent' }
    );

    expect(drained.map((row) => row.id)).toEqual(['row-alias', 'row-mid', 'row-late']);
  });

  test('returns an empty list for empty listings', () => {
    expect(
      selectDrainablePendingRows([], { executionPresent: true, targetKind: 'node_agent' })
    ).toEqual([]);
  });

  test('returns an empty list when every row is filtered out', () => {
    const spaceRow = makeRow({ id: 'row-space', targetKind: 'space_agent' });
    const nodeScoped = makeRow({ id: 'row-node', targetKind: 'node_agent', workflowNodeId: 'n' });

    expect(
      selectDrainablePendingRows([{ targetName: AGENT_NAME, rows: [spaceRow] }], {
        executionPresent: false,
        targetKind: 'node_agent',
      })
    ).toEqual([]);
    expect(
      selectDrainablePendingRows([{ targetName: AGENT_NAME, rows: [nodeScoped] }], {
        executionPresent: false,
        targetKind: 'node_agent',
      })
    ).toEqual([]);
  });
});
