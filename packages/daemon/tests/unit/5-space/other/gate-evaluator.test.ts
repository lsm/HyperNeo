/**
 * Field-Based Gate Evaluator Unit Tests
 *
 * Covers field-based evaluation:
 *   scalar fields (boolean/string/number) — ops: exists / == / !=
 *   map fields — op: count (count entries matching a value, check >= min)
 *
 * Also covers:
 *   - evaluateGate: walks gate.fields, gate opens when ALL fields pass
 *   - evaluateFieldCheck: single field evaluation
 *   - isChannelOpen: gateless channels always open, gated channels delegate
 *   - validateGateFields: runtime validation of field definitions
 */

import { describe, expect, test } from 'bun:test';
import type { Channel, Gate, GateField, GateScript } from '@neokai/shared';
import {
  evaluateFieldCheck,
  evaluateFields,
  evaluateGate,
  type GateScriptExecutorContext,
  type GateScriptExecutorFn,
  isChannelOpen,
  validateGate,
  validateGateColor,
  validateGateFields,
  validateGateLabel,
  validateGatePoll,
  validateGateScript,
} from '../../../../src/lib/space/runtime/gate-evaluator.ts';

// ---------------------------------------------------------------------------
// Scalar field — op: '==' (default comparison)
// ---------------------------------------------------------------------------

describe('GateEvaluator — scalar field (== op)', () => {
  test('opens when field matches expected value (boolean)', () => {
    const field: GateField = {
      name: 'approved',
      type: 'boolean',
      writers: ['*'],
      check: { op: '==', value: true },
    };
    const result = evaluateFieldCheck(field, { approved: true });
    expect(result.open).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  test('closed when field does not match expected value', () => {
    const field: GateField = {
      name: 'approved',
      type: 'boolean',
      writers: ['*'],
      check: { op: '==', value: true },
    };
    const result = evaluateFieldCheck(field, { approved: false });
    expect(result.open).toBe(false);
    expect(result.reason).toContain('expected true');
  });

  test('closed when field is missing (undefined !== true)', () => {
    const field: GateField = {
      name: 'approved',
      type: 'boolean',
      writers: ['*'],
      check: { op: '==', value: true },
    };
    const result = evaluateFieldCheck(field, {});
    expect(result.open).toBe(false);
  });

  test('matches string values', () => {
    const field: GateField = {
      name: 'result',
      type: 'string',
      writers: ['*'],
      check: { op: '==', value: 'passed' },
    };
    expect(evaluateFieldCheck(field, { result: 'passed' }).open).toBe(true);
    expect(evaluateFieldCheck(field, { result: 'failed' }).open).toBe(false);
  });

  test('matches number values', () => {
    const field: GateField = {
      name: 'count',
      type: 'number',
      writers: ['*'],
      check: { op: '==', value: 42 },
    };
    expect(evaluateFieldCheck(field, { count: 42 }).open).toBe(true);
    expect(evaluateFieldCheck(field, { count: 43 }).open).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scalar field — op: 'exists'
// ---------------------------------------------------------------------------

describe('GateEvaluator — scalar field (exists op)', () => {
  test('opens when field is present (any truthy value)', () => {
    const field: GateField = {
      name: 'plan',
      type: 'string',
      writers: ['*'],
      check: { op: 'exists' },
    };
    expect(evaluateFieldCheck(field, { plan: 'some plan' }).open).toBe(true);
  });

  test('opens when field is present with false value', () => {
    const field: GateField = {
      name: 'plan',
      type: 'boolean',
      writers: ['*'],
      check: { op: 'exists' },
    };
    expect(evaluateFieldCheck(field, { plan: false }).open).toBe(true);
  });

  test('opens when field is present with null value', () => {
    const field: GateField = {
      name: 'plan',
      type: 'string',
      writers: ['*'],
      check: { op: 'exists' },
    };
    expect(evaluateFieldCheck(field, { plan: null }).open).toBe(true);
  });

  test('opens when field is present with zero value', () => {
    const field: GateField = {
      name: 'count',
      type: 'number',
      writers: ['*'],
      check: { op: 'exists' },
    };
    expect(evaluateFieldCheck(field, { count: 0 }).open).toBe(true);
  });

  test('opens when field is empty string', () => {
    const field: GateField = {
      name: 'plan',
      type: 'string',
      writers: ['*'],
      check: { op: 'exists' },
    };
    expect(evaluateFieldCheck(field, { plan: '' }).open).toBe(true);
  });

  test('closed when field is undefined', () => {
    const field: GateField = {
      name: 'plan',
      type: 'string',
      writers: ['*'],
      check: { op: 'exists' },
    };
    expect(evaluateFieldCheck(field, {}).open).toBe(false);
  });

  test('closed when field is explicitly undefined', () => {
    const field: GateField = {
      name: 'plan',
      type: 'string',
      writers: ['*'],
      check: { op: 'exists' },
    };
    expect(evaluateFieldCheck(field, { plan: undefined }).open).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Scalar field — op: '!='
// ---------------------------------------------------------------------------

describe('GateEvaluator — scalar field (!= op)', () => {
  test('opens when field does not match', () => {
    const field: GateField = {
      name: 'x',
      type: 'number',
      writers: ['*'],
      check: { op: '!=', value: 42 },
    };
    expect(evaluateFieldCheck(field, { x: 43 }).open).toBe(true);
  });

  test('closed when field matches', () => {
    const field: GateField = {
      name: 'x',
      type: 'number',
      writers: ['*'],
      check: { op: '!=', value: 42 },
    };
    expect(evaluateFieldCheck(field, { x: 42 }).open).toBe(false);
  });

  test('opens when field is missing (undefined !== 42)', () => {
    const field: GateField = {
      name: 'x',
      type: 'number',
      writers: ['*'],
      check: { op: '!=', value: 42 },
    };
    expect(evaluateFieldCheck(field, {}).open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Map field — op: 'count'
// ---------------------------------------------------------------------------

describe('GateEvaluator — map field (count op)', () => {
  test('opens when enough entries match', () => {
    const field: GateField = {
      name: 'reviews',
      type: 'map',
      writers: ['*'],
      check: { op: 'count', match: 'approved', min: 2 },
    };
    const data = { reviews: { alice: 'approved', bob: 'approved', carol: 'pending' } };
    expect(evaluateFieldCheck(field, data).open).toBe(true);
  });

  test('closed when not enough entries match', () => {
    const field: GateField = {
      name: 'reviews',
      type: 'map',
      writers: ['*'],
      check: { op: 'count', match: 'approved', min: 2 },
    };
    const data = { reviews: { alice: 'approved', bob: 'pending' } };
    expect(evaluateFieldCheck(field, data).open).toBe(false);
  });

  test('closed when field is missing', () => {
    const field: GateField = {
      name: 'reviews',
      type: 'map',
      writers: ['*'],
      check: { op: 'count', match: 'approved', min: 1 },
    };
    expect(evaluateFieldCheck(field, {}).open).toBe(false);
  });

  test('closed when field is not an object', () => {
    const field: GateField = {
      name: 'reviews',
      type: 'map',
      writers: ['*'],
      check: { op: 'count', match: 'approved', min: 1 },
    };
    expect(evaluateFieldCheck(field, { reviews: 'not a map' }).open).toBe(false);
  });

  test('closed when field is an array', () => {
    const field: GateField = {
      name: 'reviews',
      type: 'map',
      writers: ['*'],
      check: { op: 'count', match: 'approved', min: 1 },
    };
    expect(evaluateFieldCheck(field, { reviews: ['approved'] }).open).toBe(false);
  });

  test('opens with exact min count', () => {
    const field: GateField = {
      name: 'votes',
      type: 'map',
      writers: ['*'],
      check: { op: 'count', match: 'ok', min: 1 },
    };
    expect(evaluateFieldCheck(field, { votes: { a: 'ok' } }).open).toBe(true);
  });

  test('closed with empty map', () => {
    const field: GateField = {
      name: 'votes',
      type: 'map',
      writers: ['*'],
      check: { op: 'count', match: 'ok', min: 1 },
    };
    expect(evaluateFieldCheck(field, { votes: {} }).open).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateGate — multiple fields (ALL must pass)
// ---------------------------------------------------------------------------

describe('GateEvaluator — evaluateGate (multiple fields)', () => {
  test('opens when all fields pass', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        { name: 'result', type: 'string', writers: ['*'], check: { op: '==', value: 'passed' } },
      ],
      resetOnCycle: false,
    };
    const result = await evaluateGate(gate, { approved: true, result: 'passed' });
    expect(result.open).toBe(true);
  });

  test('closed when any field fails', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        { name: 'result', type: 'string', writers: ['*'], check: { op: '==', value: 'passed' } },
      ],
      resetOnCycle: false,
    };
    const result = await evaluateGate(gate, { approved: true, result: 'failed' });
    expect(result.open).toBe(false);
  });

  test('opens with empty fields (no checks)', async () => {
    const gate: Gate = { id: 'g1', fields: [], resetOnCycle: false };
    const result = await evaluateGate(gate, {});
    expect(result.open).toBe(true);
  });

  test('short-circuits on first failed field', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'x', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        { name: 'y', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      resetOnCycle: false,
    };
    const result = await evaluateGate(gate, { x: false, y: true });
    expect(result.open).toBe(false);
    expect(result.reason).toContain('x');
  });

  test('gate without script evaluates synchronously under the hood', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      resetOnCycle: false,
    };
    // No script, no scriptExecutor — should still work
    const result = await evaluateGate(gate, { done: true });
    expect(result.open).toBe(true);
  });

  test('gate without script ignores scriptExecutor parameter', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      resetOnCycle: false,
    };
    const executor: GateScriptExecutorFn = async () => {
      throw new Error('should not be called');
    };
    const result = await evaluateGate(gate, { done: true }, executor, {
      workspacePath: '/tmp',
      gateId: 'g1',
      runId: 'r1',
    });
    expect(result.open).toBe(true);
  });

  test('gate with script but no scriptExecutor skips script', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      script: { interpreter: 'bash', source: 'echo test' },
      resetOnCycle: false,
    };
    // No scriptExecutor → script is ignored, falls through to fields
    const result = await evaluateGate(gate, { done: true });
    expect(result.open).toBe(true);
  });

  test('gate with script but no context skips script', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      script: { interpreter: 'bash', source: 'echo test' },
      resetOnCycle: false,
    };
    const executor: GateScriptExecutorFn = async () => {
      throw new Error('should not be called');
    };
    // No context → script is ignored
    const result = await evaluateGate(gate, { done: true }, executor);
    expect(result.open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateGate — script pre-check
// ---------------------------------------------------------------------------

describe('GateEvaluator — evaluateGate (script pre-check)', () => {
  const mockContext: GateScriptExecutorContext = {
    workspacePath: '/workspace',
    gateId: 'g1',
    runId: 'run-1',
  };

  test('script success with data merge opens gate when fields satisfied', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      script: { interpreter: 'node', source: 'process.exit(0)' },
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => ({
      success: true,
      data: { approved: true },
    });

    const result = await evaluateGate(gate, {}, executor, mockContext);
    expect(result.open).toBe(true);
  });

  test('script success with data merge — field still fails', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      script: { interpreter: 'node', source: 'process.exit(0)' },
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => ({
      success: true,
      data: { approved: false },
    });

    const result = await evaluateGate(gate, {}, executor, mockContext);
    expect(result.open).toBe(false);
    expect(result.reason).toContain('approved');
  });

  test('script failure blocks gate immediately', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      script: { interpreter: 'bash', source: 'exit 1' },
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => ({
      success: false,
      data: {},
      error: 'tests failed: 3 of 10',
    });

    const result = await evaluateGate(gate, {}, executor, mockContext);
    expect(result.open).toBe(false);
    expect(result.reason).toBe('Script check failed: tests failed: 3 of 10');
  });

  test('script failure with no error message provides default reason', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      script: { interpreter: 'bash', source: 'exit 1' },
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => ({
      success: false,
      data: {},
    });

    const result = await evaluateGate(gate, {}, executor, mockContext);
    expect(result.open).toBe(false);
    expect(result.reason).toBe('Script check failed: unknown error');
  });

  test('script success deep-merges data with existing data', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        { name: 'result', type: 'string', writers: ['*'], check: { op: '==', value: 'passed' } },
      ],
      script: { interpreter: 'node', source: 'process.exit(0)' },
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => ({
      success: true,
      data: { approved: true },
    });

    // Existing data has 'result', script adds 'approved'
    const result = await evaluateGate(gate, { result: 'passed' }, executor, mockContext);
    expect(result.open).toBe(true);
  });

  test('script success with empty data does not overwrite existing data', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      script: { interpreter: 'node', source: 'process.exit(0)' },
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => ({
      success: true,
      data: {},
    });

    const result = await evaluateGate(gate, { approved: true }, executor, mockContext);
    expect(result.open).toBe(true);
  });

  test('script-only gate (no fields, script present) returns based on script result', async () => {
    const gate: Gate = {
      id: 'g1',
      script: { interpreter: 'node', source: 'process.exit(0)' },
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => ({
      success: true,
      data: {},
    });

    const result = await evaluateGate(gate, {}, executor, mockContext);
    expect(result.open).toBe(true);
  });

  test('script-only gate fails when script fails', async () => {
    const gate: Gate = {
      id: 'g1',
      script: { interpreter: 'bash', source: 'false' },
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => ({
      success: false,
      data: {},
      error: 'command not found',
    });

    const result = await evaluateGate(gate, {}, executor, mockContext);
    expect(result.open).toBe(false);
    expect(result.reason).toBe('Script check failed: command not found');
  });

  test('script-only gate with script but no executor passes through', async () => {
    const gate: Gate = {
      id: 'g1',
      script: { interpreter: 'bash', source: 'false' },
      resetOnCycle: false,
    };

    // No executor, no fields → gate open (script ignored)
    const result = await evaluateGate(gate, {});
    expect(result.open).toBe(true);
  });

  test('script executor receives correct context', async () => {
    const gate: Gate = {
      id: 'g1',
      script: { interpreter: 'bash', source: 'echo hi' },
      resetOnCycle: false,
    };

    const script = gate.script!;
    let receivedScript: GateScript | undefined;
    let receivedContext: GateScriptExecutorContext | undefined;

    const executor: GateScriptExecutorFn = async (s, ctx) => {
      receivedScript = s;
      receivedContext = ctx;
      return { success: true, data: {} };
    };

    await evaluateGate(gate, {}, executor, mockContext);
    expect(receivedScript).toBe(script);
    expect(receivedContext).toEqual(mockContext);
  });

  test('script data merge overrides matching keys in existing data', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'status', type: 'string', writers: ['*'], check: { op: '==', value: 'passed' } },
      ],
      script: { interpreter: 'node', source: 'process.exit(0)' },
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => ({
      success: true,
      data: { status: 'passed' },
    });

    // Existing data has status: 'failed', script overrides it to 'passed'
    const result = await evaluateGate(gate, { status: 'failed' }, executor, mockContext);
    expect(result.open).toBe(true);
  });

  test('script data does not mutate original data object', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [{ name: 'extra', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      script: { interpreter: 'node', source: 'process.exit(0)' },
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => ({
      success: true,
      data: { extra: true },
    });

    const originalData: Record<string, unknown> = {};
    await evaluateGate(gate, originalData, executor, mockContext);
    expect(originalData).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// evaluateFields
// ---------------------------------------------------------------------------

describe('GateEvaluator — evaluateFields', () => {
  test('opens when all fields pass', () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      resetOnCycle: false,
    };
    const result = evaluateFields(gate, { approved: true });
    expect(result.open).toBe(true);
  });

  test('closed when any field fails', () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      resetOnCycle: false,
    };
    const result = evaluateFields(gate, { approved: false });
    expect(result.open).toBe(false);
  });

  test('opens with empty fields (no checks)', () => {
    const gate: Gate = { id: 'g1', fields: [], resetOnCycle: false };
    const result = evaluateFields(gate, {});
    expect(result.open).toBe(true);
  });

  test('short-circuits on first failed field', () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'x', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
        { name: 'y', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      resetOnCycle: false,
    };
    const result = evaluateFields(gate, { x: false, y: true });
    expect(result.open).toBe(false);
    expect(result.reason).toContain('x');
  });

  test('handles undefined fields (defaults to empty array)', () => {
    const gate: Gate = { id: 'g1', resetOnCycle: false };
    const result = evaluateFields(gate, {});
    expect(result.open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isChannelOpen
// ---------------------------------------------------------------------------

describe('GateEvaluator — isChannelOpen', () => {
  test('channel without gateId is always open', () => {
    const channel: Channel = { id: 'ch-1', from: 'a', to: 'b' };
    const result = isChannelOpen(channel, new Map());
    expect(result.open).toBe(true);
  });

  test('channel with missing gate is closed', () => {
    const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', gateId: 'missing' };
    const result = isChannelOpen(channel, new Map());
    expect(result.open).toBe(false);
    expect(result.reason).toContain('not found');
  });

  test('channel with gate delegates to evaluateGate', () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      resetOnCycle: false,
    };
    const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', gateId: 'g1' };
    const gates = new Map<string, Gate>([['g1', gate]]);

    // Without data — field not satisfied
    const closed = isChannelOpen(channel, gates, new Map());
    expect(closed.open).toBe(false);

    // With data — field satisfied
    const gateData = new Map<string, Record<string, unknown>>([['g1', { approved: true }]]);
    const open = isChannelOpen(channel, gates, gateData);
    expect(open.open).toBe(true);
  });

  test('works with Record-based gate lookups', () => {
    const gate: Gate = {
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      resetOnCycle: false,
    };
    const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', gateId: 'g1' };
    const gates: Record<string, Gate> = { g1: gate };
    const gateData: Record<string, Record<string, unknown>> = { g1: { done: true } };

    expect(isChannelOpen(channel, gates, gateData).open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateGateFields
// ---------------------------------------------------------------------------

describe('validateGateFields', () => {
  test('valid boolean field with == check', () => {
    const errors = validateGateFields([
      { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
    ]);
    expect(errors).toHaveLength(0);
  });

  test('valid string field with exists check', () => {
    const errors = validateGateFields([
      { name: 'plan', type: 'string', writers: ['planner'], check: { op: 'exists' } },
    ]);
    expect(errors).toHaveLength(0);
  });

  test('valid map field with count check', () => {
    const errors = validateGateFields([
      {
        name: 'votes',
        type: 'map',
        writers: ['reviewer'],
        check: { op: 'count', match: 'approved', min: 3 },
      },
    ]);
    expect(errors).toHaveLength(0);
  });

  test('warns when value is set on exists op', () => {
    const errors = validateGateFields([
      { name: 'x', type: 'string', writers: ['*'], check: { op: 'exists', value: 'ignored' } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('ignored');
  });

  test('rejects non-array input', () => {
    const errors = validateGateFields('not an array');
    expect(errors.length).toBeGreaterThan(0);
  });

  test('rejects field with missing name', () => {
    const errors = validateGateFields([
      { name: '', type: 'boolean', writers: ['*'], check: { op: 'exists' } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('rejects field with invalid type', () => {
    const errors = validateGateFields([
      { name: 'x', type: 'invalid', writers: ['*'], check: { op: 'exists' } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('rejects map field with scalar op', () => {
    const errors = validateGateFields([
      { name: 'votes', type: 'map', writers: ['*'], check: { op: '==' } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('rejects count check missing min', () => {
    const errors = validateGateFields([
      { name: 'votes', type: 'map', writers: ['*'], check: { op: 'count', match: 'ok' } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('rejects count check missing match', () => {
    const errors = validateGateFields([
      { name: 'votes', type: 'map', writers: ['*'], check: { op: 'count', min: 1 } },
    ]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// validateGateColor
// ---------------------------------------------------------------------------

describe('validateGateColor', () => {
  test('accepts valid hex color', () => {
    expect(validateGateColor('#ff5500')).toHaveLength(0);
  });

  test('accepts uppercase hex color', () => {
    expect(validateGateColor('#FF5500')).toHaveLength(0);
    expect(validateGateColor('#AABBCC')).toHaveLength(0);
  });

  test('accepts mixed-case hex color', () => {
    expect(validateGateColor('#aAbBcC')).toHaveLength(0);
  });

  test('accepts null (optional field)', () => {
    expect(validateGateColor(null)).toHaveLength(0);
  });

  test('accepts undefined (optional field)', () => {
    expect(validateGateColor(undefined)).toHaveLength(0);
  });

  test('rejects named color "red"', () => {
    const errors = validateGateColor('red');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('#rrggbb');
  });

  test('rejects hex without hash prefix', () => {
    const errors = validateGateColor('ff5500');
    expect(errors.length).toBeGreaterThan(0);
  });

  test('rejects 3-digit hex shorthand', () => {
    const errors = validateGateColor('#f50');
    expect(errors.length).toBeGreaterThan(0);
  });

  test('rejects 8-digit hex with alpha', () => {
    const errors = validateGateColor('#ff5500ff');
    expect(errors.length).toBeGreaterThan(0);
  });

  test('rejects non-string type', () => {
    const errors = validateGateColor(42);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('expected string');
  });
});

// ---------------------------------------------------------------------------
// validateGateLabel
// ---------------------------------------------------------------------------

describe('validateGateLabel', () => {
  test('accepts valid label', () => {
    expect(validateGateLabel('approval')).toHaveLength(0);
  });

  test('accepts empty string', () => {
    expect(validateGateLabel('')).toHaveLength(0);
  });

  test('accepts null (optional field)', () => {
    expect(validateGateLabel(null)).toHaveLength(0);
  });

  test('accepts undefined (optional field)', () => {
    expect(validateGateLabel(undefined)).toHaveLength(0);
  });

  test('accepts label at exactly 20 characters', () => {
    expect(validateGateLabel('12345678901234567890')).toHaveLength(0);
  });

  test('rejects label longer than 20 characters', () => {
    const errors = validateGateLabel('123456789012345678901');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('20 characters');
  });

  test('rejects non-string type', () => {
    const errors = validateGateLabel(42);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('expected string');
  });
});

// ---------------------------------------------------------------------------
// validateGateScript
// ---------------------------------------------------------------------------

describe('validateGateScript', () => {
  test('accepts valid bash script', () => {
    expect(validateGateScript({ interpreter: 'bash', source: 'echo hello' })).toHaveLength(0);
  });

  test('accepts valid node script', () => {
    expect(validateGateScript({ interpreter: 'node', source: 'process.exit(0)' })).toHaveLength(0);
  });

  test('accepts valid python3 script', () => {
    expect(validateGateScript({ interpreter: 'python3', source: 'print("hello")' })).toHaveLength(
      0
    );
  });

  test('accepts script with timeoutMs', () => {
    expect(
      validateGateScript({ interpreter: 'bash', source: 'echo hi', timeoutMs: 5000 })
    ).toHaveLength(0);
  });

  test('accepts null (optional field)', () => {
    expect(validateGateScript(null)).toHaveLength(0);
  });

  test('accepts undefined (optional field)', () => {
    expect(validateGateScript(undefined)).toHaveLength(0);
  });

  test('rejects invalid interpreter "ruby"', () => {
    const errors = validateGateScript({ interpreter: 'ruby', source: 'puts "hi"' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('interpreter');
    expect(errors[0]).toContain('bash');
  });

  test('rejects invalid interpreter "javascript"', () => {
    const errors = validateGateScript({ interpreter: 'javascript', source: 'true' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('interpreter');
  });

  test('rejects empty source string', () => {
    const errors = validateGateScript({ interpreter: 'bash', source: '' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('source');
    expect(errors[0]).toContain('non-empty');
  });

  test('rejects non-string source', () => {
    const errors = validateGateScript({ interpreter: 'bash', source: 42 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('source');
  });

  test('rejects non-object input', () => {
    const errors = validateGateScript('not an object');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('expected object');
  });

  test('rejects false as script', () => {
    const errors = validateGateScript(false);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('expected object');
  });

  test('rejects 0 as script', () => {
    const errors = validateGateScript(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('expected object');
  });

  test('rejects timeoutMs exceeding 120000', () => {
    const errors = validateGateScript({
      interpreter: 'bash',
      source: 'echo hi',
      timeoutMs: 200000,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('120000');
  });

  test('rejects timeoutMs at exactly 120001', () => {
    const errors = validateGateScript({
      interpreter: 'bash',
      source: 'echo hi',
      timeoutMs: 120001,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  test('accepts timeoutMs at exactly 120000', () => {
    expect(
      validateGateScript({ interpreter: 'bash', source: 'echo hi', timeoutMs: 120000 })
    ).toHaveLength(0);
  });

  test('rejects negative timeoutMs', () => {
    const errors = validateGateScript({ interpreter: 'bash', source: 'echo hi', timeoutMs: -1000 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('positive');
  });

  test('rejects zero timeoutMs', () => {
    const errors = validateGateScript({ interpreter: 'bash', source: 'echo hi', timeoutMs: 0 });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('positive');
  });

  test('rejects non-number timeoutMs', () => {
    const errors = validateGateScript({
      interpreter: 'bash',
      source: 'echo hi',
      timeoutMs: '30s',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('timeoutMs');
  });
});

// ---------------------------------------------------------------------------
// validateGatePoll
// ---------------------------------------------------------------------------

describe('validateGatePoll', () => {
  test('accepts undefined (optional field)', () => {
    expect(validateGatePoll(undefined)).toHaveLength(0);
  });

  test('accepts null (optional field)', () => {
    expect(validateGatePoll(null)).toHaveLength(0);
  });

  test('accepts valid poll with minimum intervalMs', () => {
    expect(
      validateGatePoll({ intervalMs: 10_000, script: 'echo hello', target: 'from' })
    ).toHaveLength(0);
  });

  test('accepts valid poll with "to" target', () => {
    expect(
      validateGatePoll({ intervalMs: 30_000, script: 'echo hello', target: 'to' })
    ).toHaveLength(0);
  });

  test('accepts valid poll with messageTemplate', () => {
    expect(
      validateGatePoll({
        intervalMs: 60_000,
        script: 'echo hello',
        target: 'from',
        messageTemplate: 'Result: {{output}}',
      })
    ).toHaveLength(0);
  });

  test('rejects intervalMs below 10000', () => {
    const errors = validateGatePoll({ intervalMs: 5_000, script: 'echo hi', target: 'from' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('intervalMs');
    expect(errors[0]).toContain('10000');
  });

  test('rejects intervalMs at 9999', () => {
    const errors = validateGatePoll({ intervalMs: 9_999, script: 'echo hi', target: 'from' });
    expect(errors.length).toBeGreaterThan(0);
  });

  test('accepts intervalMs at exactly 10000', () => {
    expect(
      validateGatePoll({ intervalMs: 10_000, script: 'echo hi', target: 'from' })
    ).toHaveLength(0);
  });

  test('rejects NaN intervalMs', () => {
    const errors = validateGatePoll({ intervalMs: NaN, script: 'echo hi', target: 'from' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('finite');
  });

  test('rejects Infinity intervalMs', () => {
    const errors = validateGatePoll({ intervalMs: Infinity, script: 'echo hi', target: 'from' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('finite');
  });

  test('rejects empty script string', () => {
    const errors = validateGatePoll({ intervalMs: 30_000, script: '', target: 'from' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('script');
  });

  test('rejects whitespace-only script string', () => {
    const errors = validateGatePoll({ intervalMs: 30_000, script: '   ', target: 'from' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('script');
  });

  test('rejects non-string script', () => {
    const errors = validateGatePoll({ intervalMs: 30_000, script: 42, target: 'from' });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('script');
  });

  test('rejects invalid target', () => {
    const errors = validateGatePoll({
      intervalMs: 30_000,
      script: 'echo hi',
      target: 'invalid',
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('target');
  });

  test('rejects undefined target', () => {
    const errors = validateGatePoll({
      intervalMs: 30_000,
      script: 'echo hi',
      target: undefined,
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  test('rejects non-object input', () => {
    const errors = validateGatePoll('not an object');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('expected object');
  });

  test('rejects non-string messageTemplate', () => {
    const errors = validateGatePoll({
      intervalMs: 30_000,
      script: 'echo hi',
      target: 'from',
      messageTemplate: 42,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('messageTemplate');
  });
});

// ---------------------------------------------------------------------------
// validateGate
// ---------------------------------------------------------------------------

describe('validateGate', () => {
  test('gate with empty fields and no script returns errors', () => {
    const errors = validateGate({ id: 'g1', fields: [], resetOnCycle: false });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('at least one'))).toBe(true);
  });

  test('gate with only non-empty fields is valid', () => {
    const errors = validateGate({
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      resetOnCycle: false,
    });
    expect(errors).toHaveLength(0);
  });

  test('gate with only script is valid', () => {
    const errors = validateGate({
      id: 'g1',
      script: { interpreter: 'node', source: 'process.exit(0)' },
      resetOnCycle: false,
    });
    expect(errors).toHaveLength(0);
  });

  test('gate with codex review bot feature is valid', () => {
    const errors = validateGate({
      id: 'g1',
      features: { codex_review_bot: true },
      resetOnCycle: false,
    });
    expect(errors).toHaveLength(0);
  });

  test('gate with empty features and no fields or script returns error', () => {
    const errors = validateGate({
      id: 'g1',
      features: {},
      resetOnCycle: false,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('at least one'))).toBe(true);
  });

  test('gate with both fields and script is valid', () => {
    const errors = validateGate({
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      script: { interpreter: 'bash', source: 'echo hi' },
      resetOnCycle: false,
    });
    expect(errors).toHaveLength(0);
  });

  test('gate with no fields and no script returns error', () => {
    const errors = validateGate({ id: 'g1', resetOnCycle: false });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('at least one'))).toBe(true);
  });

  test('gate with invalid color produces error', () => {
    const errors = validateGate({
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      color: 'red',
      resetOnCycle: false,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('color'))).toBe(true);
  });

  test('gate with valid color passes', () => {
    const errors = validateGate({
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      color: '#ff5500',
      resetOnCycle: false,
    });
    expect(errors).toHaveLength(0);
  });

  test('gate with label longer than 20 chars produces error', () => {
    const errors = validateGate({
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      label: 'this label is way too long for the limit',
      resetOnCycle: false,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('label'))).toBe(true);
  });

  test('gate with valid label passes', () => {
    const errors = validateGate({
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      label: 'approval gate',
      resetOnCycle: false,
    });
    expect(errors).toHaveLength(0);
  });

  test('gate with invalid script interpreter produces error', () => {
    const errors = validateGate({
      id: 'g1',
      script: { interpreter: 'ruby', source: 'puts "hi"' },
      resetOnCycle: false,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('interpreter'))).toBe(true);
  });

  test('gate with empty script source produces error', () => {
    const errors = validateGate({
      id: 'g1',
      script: { interpreter: 'bash', source: '' },
      resetOnCycle: false,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('source'))).toBe(true);
  });

  test('gate with script timeoutMs exceeding 120000 produces error', () => {
    const errors = validateGate({
      id: 'g1',
      script: { interpreter: 'bash', source: 'echo hi', timeoutMs: 200000 },
      resetOnCycle: false,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('timeoutMs'))).toBe(true);
  });

  test('rejects non-object gate input', () => {
    const errors = validateGate('not an object');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('expected object');
  });

  test('rejects null gate input', () => {
    const errors = validateGate(null);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('expected object');
  });

  test('runs validateGateFields when fields are present and non-empty', () => {
    const errors = validateGate({
      id: 'g1',
      fields: [{ name: '', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      resetOnCycle: false,
    });
    expect(errors.length).toBeGreaterThan(0);
    // Should include the field-level error for empty name
    expect(errors.some((e) => e.includes('name'))).toBe(true);
  });

  test('does not run validateGateFields when fields is empty array', () => {
    const errors = validateGate({ id: 'g1', fields: [], resetOnCycle: false });
    // Should only have the "at least one" error, no field-level errors
    expect(errors.every((e) => !e.includes('[0]'))).toBe(true);
  });

  test('runs validateGateFields for non-array fields value', () => {
    const errors = validateGate({ id: 'g1', fields: 'bad', resetOnCycle: false });
    // Should have both the "expected an array" error and the "at least one" error
    expect(errors.some((e) => e.includes('expected an array'))).toBe(true);
    expect(errors.some((e) => e.includes('at least one'))).toBe(true);
  });

  test('gate with valid poll passes', () => {
    const errors = validateGate({
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      poll: { intervalMs: 30_000, script: 'echo hello', target: 'from' },
      resetOnCycle: false,
    });
    expect(errors).toHaveLength(0);
  });

  test('gate with invalid poll intervalMs produces error', () => {
    const errors = validateGate({
      id: 'g1',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      poll: { intervalMs: 5_000, script: 'echo hello', target: 'from' },
      resetOnCycle: false,
    });
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => e.includes('intervalMs'))).toBe(true);
  });

  test('gate with poll but no fields or script still requires fields or script', () => {
    const errors = validateGate({
      id: 'g1',
      poll: { intervalMs: 30_000, script: 'echo hello', target: 'from' },
      resetOnCycle: false,
    });
    // poll does NOT count as a gate check mechanism
    expect(errors.some((e) => e.includes('at least one'))).toBe(true);
  });

  test('collects all errors from color, label, script, and fields', () => {
    const errors = validateGate({
      id: 'g1',
      color: 'red',
      label: 'a label that is definitely way too long for this',
      script: { interpreter: 'ruby', source: '' },
      fields: [],
      resetOnCycle: false,
    });
    // script is present so "at least one" check passes, but color/label/script have errors
    expect(errors.some((e) => e.includes('color'))).toBe(true);
    expect(errors.some((e) => e.includes('label'))).toBe(true);
    expect(errors.some((e) => e.includes('interpreter'))).toBe(true);
    expect(errors.some((e) => e.includes('source'))).toBe(true);
    // No "at least one" error because script is present
    expect(errors.some((e) => e.includes('at least one'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateGate — script returns non-JSON stdout (empty data merge)
// ---------------------------------------------------------------------------

describe('GateEvaluator — evaluateGate (non-JSON stdout)', () => {
  const mockContext: GateScriptExecutorContext = {
    workspacePath: '/workspace',
    gateId: 'g1',
    runId: 'run-1',
  };

  test('executor returns empty data (non-JSON stdout) → field evaluation uses original data', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      script: { interpreter: 'bash', source: 'echo "not json"' },
      resetOnCycle: false,
    };

    // Simulates gate-script-executor behavior when stdout is not valid JSON:
    // parseJsonStdout returns {}, so executor returns { success: true, data: {} }
    const executor: GateScriptExecutorFn = async () => ({
      success: true,
      data: {},
    });

    // Original data has approved: true
    const result = await evaluateGate(gate, { approved: true }, executor, mockContext);
    expect(result.open).toBe(true);
  });

  test('executor returns empty data → field evaluation fails with original data', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      script: { interpreter: 'bash', source: 'echo "not json"' },
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => ({
      success: true,
      data: {},
    });

    // Original data has approved: false — should remain false after merge
    const result = await evaluateGate(gate, { approved: false }, executor, mockContext);
    expect(result.open).toBe(false);
    expect(result.reason).toContain('approved');
  });

  test('executor returns empty data and no original data → field evaluation uses empty object', async () => {
    const gate: Gate = {
      id: 'g1',
      fields: [{ name: 'approved', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      script: { interpreter: 'bash', source: 'echo "plaintext"' },
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => ({
      success: true,
      data: {},
    });

    const result = await evaluateGate(gate, {}, executor, mockContext);
    expect(result.open).toBe(false);
    expect(result.reason).toContain('does not exist');
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility — gates without script field
// ---------------------------------------------------------------------------

describe('GateEvaluator — backward compatibility (gates without script)', () => {
  test('gate without script field evaluates fields normally', async () => {
    const gate: Gate = {
      id: 'legacy-gate',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      resetOnCycle: false,
    };

    const result = await evaluateGate(gate, { approved: true });
    expect(result.open).toBe(true);
  });

  test('gate with script: undefined evaluates same as no script', async () => {
    const gate: Gate = {
      id: 'no-script-gate',
      fields: [{ name: 'ready', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      script: undefined,
      resetOnCycle: false,
    };

    // Script is undefined → scriptExecutor is never called
    const executor: GateScriptExecutorFn = async () => {
      throw new Error('should not be called');
    };
    const result = await evaluateGate(gate, { ready: true }, executor);
    expect(result.open).toBe(true);
  });

  test('gate with script: null evaluates same as no script', async () => {
    const gate: Gate = {
      id: 'null-script-gate',
      fields: [{ name: 'ready', type: 'boolean', writers: ['*'], check: { op: 'exists' } }],
      script: null,
      resetOnCycle: false,
    };

    const executor: GateScriptExecutorFn = async () => {
      throw new Error('should not be called');
    };
    const result = await evaluateGate(gate, { ready: true }, executor);
    expect(result.open).toBe(true);
  });

  test('gate with empty fields and no script opens (legacy runtime behavior)', async () => {
    // At runtime, gates loaded from storage may have fields: [] and no script.
    // evaluateFields handles this: empty array → no checks → open.
    // This is different from validateGate (creation-time), which rejects it.
    const gate: Gate = {
      id: 'legacy-empty-gate',
      fields: [],
      resetOnCycle: false,
    };

    const result = await evaluateGate(gate, {});
    expect(result.open).toBe(true);
  });

  test('gate with no fields key and no script opens (missing fields defaults to [])', async () => {
    // Fields is optional on Gate; when absent, evaluateFields uses ?? []
    const gate: Gate = {
      id: 'no-fields-key-gate',
      resetOnCycle: false,
    };

    const result = await evaluateGate(gate, {});
    expect(result.open).toBe(true);
  });

  test('field-only gate with scriptExecutor provided is never called', async () => {
    const gate: Gate = {
      id: 'field-only-with-executor',
      fields: [{ name: 'done', type: 'boolean', writers: ['*'], check: { op: '==', value: true } }],
      resetOnCycle: false,
    };

    let called = false;
    const executor: GateScriptExecutorFn = async () => {
      called = true;
      return { success: true, data: {} };
    };

    await evaluateGate(gate, { done: true }, executor);
    expect(called).toBe(false);
  });

  test('gate with label and color but no script evaluates fields', async () => {
    const gate: Gate = {
      id: 'styled-gate',
      label: 'Approval',
      color: '#22c55e',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      resetOnCycle: false,
    };

    const result = await evaluateGate(gate, { approved: true });
    expect(result.open).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isChannelOpen — remains synchronous
// ---------------------------------------------------------------------------

describe('GateEvaluator — isChannelOpen synchronous guarantee', () => {
  test('isChannelOpen returns a plain object (not a Promise)', () => {
    const channel: Channel = { id: 'ch-1', from: 'a', to: 'b' };
    const result = isChannelOpen(channel, new Map());

    // Verify it's not a thenable (Promise)
    expect(typeof result.then).toBe('undefined');
    expect(result.open).toBe(true);
  });

  test('isChannelOpen with gated channel returns plain object (not a Promise)', () => {
    const gate: Gate = {
      id: 'g1',
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      resetOnCycle: false,
    };
    const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', gateId: 'g1' };
    const gates = new Map<string, Gate>([['g1', gate]]);

    const result = isChannelOpen(channel, gates, new Map());

    expect(typeof result.then).toBe('undefined');
    expect(result.open).toBe(false);
  });

  test('isChannelOpen ignores gate script — no async execution', () => {
    const gate: Gate = {
      id: 'g1',
      script: { interpreter: 'bash', source: 'echo fail; exit 1' },
      fields: [
        { name: 'approved', type: 'boolean', writers: ['*'], check: { op: '==', value: true } },
      ],
      resetOnCycle: false,
    };
    const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', gateId: 'g1' };
    const gates = new Map<string, Gate>([['g1', gate]]);

    // Gate has a script that would fail, but isChannelOpen never runs it.
    // It only evaluates fields, and with approved: true the gate opens.
    const gateData = new Map<string, Record<string, unknown>>([['g1', { approved: true }]]);
    const result = isChannelOpen(channel, gates, gateData);

    expect(typeof result.then).toBe('undefined');
    expect(result.open).toBe(true);
  });

  test('isChannelOpen with script-only gate (no fields) opens without running script', () => {
    const gate: Gate = {
      id: 'g1',
      script: { interpreter: 'bash', source: 'exit 1' },
      resetOnCycle: false,
    };
    const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', gateId: 'g1' };
    const gates = new Map<string, Gate>([['g1', gate]]);

    // Script-only gate: isChannelOpen uses evaluateFields which checks gate.fields ?? [].
    // Empty fields → open. Script is never run.
    const result = isChannelOpen(channel, gates);

    expect(typeof result.then).toBe('undefined');
    expect(result.open).toBe(true);
  });

  test('isChannelOpen works with gate that has optional fields (undefined)', () => {
    const gate: Gate = {
      id: 'g1',
      resetOnCycle: false,
    };
    const channel: Channel = { id: 'ch-1', from: 'a', to: 'b', gateId: 'g1' };
    const gates = new Map<string, Gate>([['g1', gate]]);

    const result = isChannelOpen(channel, gates);
    expect(typeof result.then).toBe('undefined');
    expect(result.open).toBe(true);
  });
});
