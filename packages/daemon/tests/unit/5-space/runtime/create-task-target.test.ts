import { describe, expect, test } from 'bun:test';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import {
  resolveCreateTaskTarget,
  resolveCreatedBy,
} from '../../../../src/lib/space/operations/create-task-target';
import { createTestSession } from '../../../helpers/database';

const rpc: OperationCaller = { source: 'rpc' };
const internal: OperationCaller = { source: 'internal' };
const mcp: OperationCaller = { source: 'mcp', sessionId: 'agent-session' };
const scopeReason = 'Task creation requires a session in the owning Space';
const spaceOnlyReason =
  'dependsOn, draft, preferredWorkflowId and workspacePath require a Space task';

describe('resolveCreateTaskTarget', () => {
  test.each([
    ['rpc standalone', rpc, undefined, {}, { value: undefined }],
    ['rpc targeted', rpc, undefined, { spaceId: 'a' }, { value: 'a' }],
    ['internal standalone', internal, undefined, {}, { value: undefined }],
    ['internal targeted', internal, 'other', { spaceId: 'a' }, { value: 'a' }],
    ['mcp session space, no input', mcp, 'a', {}, { value: 'a' }],
    ['mcp matching input', mcp, 'a', { spaceId: 'a' }, { value: 'a' }],
    ['mcp foreign input', mcp, 'a', { spaceId: 'b' }, { reason: scopeReason }],
    [
      'mcp outside any space requesting a space',
      mcp,
      undefined,
      { spaceId: 'b' },
      { reason: scopeReason },
    ],
    [
      'standalone with dependsOn',
      rpc,
      undefined,
      { dependsOn: ['x'] },
      { reason: spaceOnlyReason },
    ],
    ['standalone with draft', rpc, undefined, { draft: true }, { reason: spaceOnlyReason }],
    [
      'standalone with preferredWorkflowId',
      rpc,
      undefined,
      { preferredWorkflowId: 'wf' },
      { reason: spaceOnlyReason },
    ],
    [
      'standalone with workspacePath',
      rpc,
      undefined,
      { workspacePath: '/repo' },
      { reason: spaceOnlyReason },
    ],
    [
      'Space target with Space-only fields',
      rpc,
      undefined,
      {
        spaceId: 'a',
        dependsOn: ['x'],
        draft: true,
        preferredWorkflowId: 'wf',
        workspacePath: '/repo',
      },
      { value: 'a' },
    ],
  ])('%s', (_label, caller, sessionSpaceId, input, expected) => {
    expect(resolveCreateTaskTarget(input, caller, sessionSpaceId)).toEqual(expected);
  });
});

describe('resolveCreatedBy', () => {
  test('null session yields null', () => {
    expect(resolveCreatedBy(null)).toBeNull();
  });

  test('space_chat session yields space-agent regardless of provenance', () => {
    const session = { ...createTestSession('s1'), type: 'space_chat' as const };
    expect(resolveCreatedBy(session)).toBe('space-agent');
  });

  test('session with provenance yields the agent name', () => {
    const base = createTestSession('s2');
    const session = {
      ...base,
      type: 'worker' as const,
      metadata: {
        ...base.metadata,
        promptProvenance: { source: 'test', hash: 'h', agentName: 'Scout' },
      },
    };
    expect(resolveCreatedBy(session)).toBe('Scout');
  });

  test('session without provenance yields null', () => {
    const session = { ...createTestSession('s3'), type: 'worker' as const };
    expect(resolveCreatedBy(session)).toBeNull();
  });
});
