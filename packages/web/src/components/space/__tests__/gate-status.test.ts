import { describe, it, expect } from 'vitest';
import type { Gate, GateField } from '@neokai/shared';
import {
  evaluateGateStatus,
  evalFieldStatus,
  isExternalApprovalGate,
  parseScriptResult,
} from '../gate-status';

function approvedField(writers: string[] = []): GateField {
  return {
    name: 'approved',
    type: 'boolean',
    writers,
    check: { op: '==', value: true },
  };
}

function existsField(name: string): GateField {
  return {
    name,
    type: 'string',
    writers: ['*'],
    check: { op: 'exists' },
  };
}

function gate(fields: GateField[]): Gate {
  return { id: 'g1', fields, resetOnCycle: false };
}

describe('parseScriptResult', () => {
  it('returns failed=false when _scriptResult is missing', () => {
    expect(parseScriptResult({})).toEqual({ failed: false });
  });

  it('returns failed=true with reason when success=false', () => {
    expect(parseScriptResult({ _scriptResult: { success: false, reason: 'boom' } })).toEqual({
      failed: true,
      reason: 'boom',
    });
  });

  it('returns failed=false when success=true', () => {
    expect(parseScriptResult({ _scriptResult: { success: true } })).toEqual({ failed: false });
  });

  it('ignores primitive _scriptResult (does not treat string/number as failed)', () => {
    expect(parseScriptResult({ _scriptResult: 'boom' })).toEqual({ failed: false });
    expect(parseScriptResult({ _scriptResult: 42 })).toEqual({ failed: false });
    expect(parseScriptResult({ _scriptResult: null })).toEqual({ failed: false });
  });

  it('ignores reason that is not a string', () => {
    expect(parseScriptResult({ _scriptResult: { success: false, reason: 42 } })).toEqual({
      failed: true,
      reason: undefined,
    });
  });
});

describe('isExternalApprovalGate', () => {
  it('returns true when a field named "approved" has empty writers', () => {
    expect(isExternalApprovalGate([approvedField([])])).toBe(true);
  });

  it('returns false when "approved" has agent writers', () => {
    expect(isExternalApprovalGate([approvedField(['agent-1'])])).toBe(false);
  });

  it('returns false when there is no "approved" field', () => {
    expect(isExternalApprovalGate([existsField('other')])).toBe(false);
  });
});

describe('evalFieldStatus', () => {
  it('exists: open when value is defined', () => {
    expect(evalFieldStatus(existsField('foo'), { foo: 'x' })).toBe('open');
    expect(evalFieldStatus(existsField('foo'), {})).toBe('blocked');
  });

  it('== op: open on equality', () => {
    const f: GateField = {
      name: 'approved',
      type: 'boolean',
      writers: [],
      check: { op: '==', value: true },
    };
    expect(evalFieldStatus(f, { approved: true })).toBe('open');
    expect(evalFieldStatus(f, { approved: false })).toBe('blocked');
  });

  it('count op: open when min met', () => {
    const f: GateField = {
      name: 'votes',
      type: 'map',
      writers: ['*'],
      check: { op: 'count', match: 'yes', min: 2 },
    };
    expect(evalFieldStatus(f, { votes: { a: 'yes', b: 'yes' } })).toBe('open');
    expect(evalFieldStatus(f, { votes: { a: 'yes' } })).toBe('blocked');
    expect(evalFieldStatus(f, { votes: 'not-a-map' })).toBe('blocked');
  });
});

describe('evaluateGateStatus', () => {
  it('script failure short-circuits to blocked', () => {
    expect(evaluateGateStatus(gate([approvedField()]), { approved: true }, true)).toBe('blocked');
  });

  it('returns open for a gate with no fields', () => {
    expect(evaluateGateStatus(gate([]), {})).toBe('open');
  });

  it('external approval: waiting_human when approved is undefined', () => {
    expect(evaluateGateStatus(gate([approvedField()]), {})).toBe('waiting_human');
  });

  it('external approval: open when approved=true', () => {
    expect(evaluateGateStatus(gate([approvedField()]), { approved: true })).toBe('open');
  });

  it('external approval: blocked when approved=false', () => {
    expect(evaluateGateStatus(gate([approvedField()]), { approved: false })).toBe('blocked');
  });

  it('external approval: re-approving after a rejection evaluates as open', () => {
    // The daemon allows a human to re-submit approved=true after a rejection
    // (or undefined → false → true transitions). evaluateGateStatus is
    // stateless and must respect the latest data value.
    const g = gate([approvedField()]);
    expect(evaluateGateStatus(g, { approved: false })).toBe('blocked');
    expect(evaluateGateStatus(g, { approved: true })).toBe('open');
    expect(evaluateGateStatus(g, {})).toBe('waiting_human');
  });

  it('external approval: approved=true but peer field still failing → blocked', () => {
    const g = gate([approvedField(), existsField('pr_url')]);
    expect(evaluateGateStatus(g, { approved: true })).toBe('blocked');
    expect(evaluateGateStatus(g, { approved: true, pr_url: 'https://…' })).toBe('open');
  });

  it('non-external gate: blocked until all fields pass', () => {
    const g = gate([existsField('a'), existsField('b')]);
    expect(evaluateGateStatus(g, { a: '1' })).toBe('blocked');
    expect(evaluateGateStatus(g, { a: '1', b: '2' })).toBe('open');
  });
});
