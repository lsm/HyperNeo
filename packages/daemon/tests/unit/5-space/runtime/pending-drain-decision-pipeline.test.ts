import { describe, expect, test } from 'bun:test';
import {
  applyDrainableRowsGate,
  applyEmptyListingsGate,
  applyNoDrainableRowsGate,
  decidePendingDrainAdmission,
  type PendingDrainCtx,
  type PendingDrainInput,
} from '../../../../src/lib/space/runtime/pending-drain-decision-pipeline';
import {
  type PendingQueueListing,
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

function undecided(input: PendingDrainInput): PendingDrainCtx {
  return { ...input, decision: null };
}

describe('pending drain decisionRun gates', () => {
  test('non-deciding gates pass the ctx through by reference', () => {
    const withRows = undecided({
      listings: [{ targetName: AGENT_NAME, rows: [makeRow()] }],
      admission: { executionPresent: true, targetKind: 'node_agent' },
    });
    expect(applyEmptyListingsGate(withRows)).toBe(withRows);

    const inadmissible = undecided({
      listings: [{ targetName: AGENT_NAME, rows: [makeRow({ targetKind: 'space_agent' })] }],
      admission: { executionPresent: true, targetKind: 'node_agent' },
    });
    expect(applyDrainableRowsGate(inadmissible)).toBe(inadmissible);
  });

  test('applyNoDrainableRowsGate always decides the empty skip', () => {
    const ctx = undecided({
      listings: [{ targetName: AGENT_NAME, rows: [makeRow()] }],
      admission: { executionPresent: true, targetKind: 'node_agent' },
    });
    expect(applyNoDrainableRowsGate(ctx).decision).toEqual({
      action: 'skip',
      reason: 'no_drainable_rows',
    });
  });

  test('applyEmptyListingsGate short-circuits listings with no rows at all', () => {
    expect(
      applyEmptyListingsGate(
        undecided({ listings: [], admission: { executionPresent: true, targetKind: 'node_agent' } })
      ).decision
    ).toEqual({ action: 'skip', reason: 'no_pending_rows' });
    expect(
      applyEmptyListingsGate(
        undecided({
          listings: [
            { targetName: AGENT_NAME, rows: [] },
            { targetName: `${NODE_NAME}/${AGENT_NAME}`, rows: [] },
          ],
          admission: { executionPresent: true, targetKind: 'node_agent' },
        })
      ).decision
    ).toEqual({ action: 'skip', reason: 'no_pending_rows' });
  });

  test('applyDrainableRowsGate decides drain with the admissible rows', () => {
    const drainable = makeRow({ id: 'row-drain' });
    const decision = applyDrainableRowsGate(
      undecided({
        listings: [{ targetName: AGENT_NAME, rows: [drainable] }],
        admission: { executionPresent: true, targetKind: 'node_agent' },
      })
    ).decision;
    expect(decision).toEqual({ action: 'drain', rows: [drainable] });
  });
});

describe('pending drain decisionRun precedence', () => {
  test('empty listings outrank row admission: the short-circuit answers, not the terminal skip', () => {
    const decision = decidePendingDrainAdmission({
      listings: [{ targetName: AGENT_NAME, rows: [] }],
      admission: { executionPresent: false, targetKind: 'node_agent' },
    });
    expect(decision).toEqual({ action: 'skip', reason: 'no_pending_rows' });
  });

  test('row admission outranks the terminal skip: any admissible row drains the queue', () => {
    const filteredOut = makeRow({ id: 'row-space', targetKind: 'space_agent' });
    const drainable = makeRow({ id: 'row-node', workflowNodeId: 'node-build' });
    const decision = decidePendingDrainAdmission({
      listings: [{ targetName: AGENT_NAME, rows: [filteredOut, drainable] }],
      admission: { executionPresent: true, targetKind: 'node_agent' },
    });
    expect(decision).toEqual({ action: 'drain', rows: [drainable] });
  });

  test('listed rows that admission filters out fall through to the terminal skip', () => {
    expect(
      decidePendingDrainAdmission({
        listings: [{ targetName: AGENT_NAME, rows: [makeRow({ targetKind: 'space_agent' })] }],
        admission: { executionPresent: true, targetKind: 'node_agent' },
      })
    ).toEqual({ action: 'skip', reason: 'no_drainable_rows' });
    expect(
      decidePendingDrainAdmission({
        listings: [{ targetName: AGENT_NAME, rows: [makeRow({ workflowNodeId: 'node-build' })] }],
        admission: { executionPresent: false, targetKind: 'node_agent' },
      })
    ).toEqual({ action: 'skip', reason: 'no_drainable_rows' });
  });
});

describe('pending drain decisionRun parity with the I2 core', () => {
  const listingSets: PendingQueueListing[][] = [
    [],
    [{ targetName: AGENT_NAME, rows: [] }],
    [{ targetName: AGENT_NAME, rows: [makeRow({ id: 'row-run' })] }],
    [{ targetName: AGENT_NAME, rows: [makeRow({ id: 'row-space', targetKind: 'space_agent' })] }],
    [
      {
        targetName: AGENT_NAME,
        rows: [
          makeRow({ id: 'row-node', workflowNodeId: 'node-build' }),
          makeRow({ id: 'row-run' }),
        ],
      },
    ],
    [
      { targetName: AGENT_NAME, rows: [makeRow({ id: 'row-dup', createdAt: 2 })] },
      {
        targetName: `${NODE_NAME}/${AGENT_NAME}`,
        rows: [makeRow({ id: 'row-dup', createdAt: 2 })],
      },
    ],
    [
      { targetName: AGENT_NAME, rows: [makeRow({ id: 'row-late', createdAt: 3 })] },
      {
        targetName: `${NODE_NAME}/${AGENT_NAME}`,
        rows: [makeRow({ id: 'row-early', createdAt: 1 })],
      },
    ],
  ];

  test('the pipeline drains exactly the rows the I2 core selects, in its order', () => {
    for (const listings of listingSets) {
      for (const executionPresent of [false, true]) {
        const input: PendingDrainInput = {
          listings,
          admission: { executionPresent, targetKind: 'node_agent' },
        };
        const expected = selectDrainablePendingRows(listings, input.admission);
        const decision = decidePendingDrainAdmission(input);
        expect(decision.action).toBe(expected.length > 0 ? 'drain' : 'skip');
        if (decision.action === 'drain') {
          expect(decision.rows).toEqual(expected);
        }
      }
    }
  });
});

describe('pending drain decisionRun core', () => {
  test('the pipeline decides synchronously', () => {
    let observed: unknown = 'unset';
    Promise.resolve().then(() => {
      observed = 'microtask ran first';
    });
    const decision = decidePendingDrainAdmission({
      listings: [{ targetName: AGENT_NAME, rows: [makeRow()] }],
      admission: { executionPresent: true, targetKind: 'node_agent' },
    });
    expect(decision.action).toBe('drain');
    expect(observed).toBe('unset');
  });
});
