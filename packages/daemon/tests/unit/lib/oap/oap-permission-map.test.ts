import { describe, expect, it } from 'vitest';
import {
  mapPermissionRequest,
  mapPermissionResolution,
  mapUserInputRequest,
} from '../../../../src/lib/oap/oap-permission-map.ts';

describe('OAP interaction mapping', () => {
  const permission = {
    interaction_id: 'interaction-1',
    session_id: 'session-1',
    run_id: 'run-1',
    requested_by: 'agent',
    responded_by: 'user',
    tool_call_id: 'tool-1',
    title: 'Allow Codex action',
    arguments_json: { command: 'echo synthetic' },
    choices: [
      { id: 'approve', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ],
  };

  it('maps permission requests and both decisions', () => {
    expect(
      mapPermissionRequest(permission, { tool_call_id: 'tool-1', name: 'codex.command' })
    ).toEqual({
      toolName: 'codex.command',
      input: { command: 'echo synthetic' },
      toolUseID: 'tool-1',
    });
    expect(mapPermissionResolution(permission, { behavior: 'allow' })).toEqual({
      interaction_id: 'interaction-1',
      session_id: 'session-1',
      run_id: 'run-1',
      requested_by: 'agent',
      responded_by: 'user',
      granted: true,
      choice_id: 'approve',
    });
    expect(mapPermissionResolution(permission, { behavior: 'deny', message: 'no' })).toEqual({
      interaction_id: 'interaction-1',
      session_id: 'session-1',
      run_id: 'run-1',
      requested_by: 'agent',
      responded_by: 'user',
      granted: false,
      choice_id: 'deny',
      reason: 'no',
    });
  });

  it('uses correlated call identity and fails closed on unknown choices', () => {
    expect(() =>
      mapPermissionRequest(permission, { tool_call_id: 'wrong', name: 'Bash' })
    ).toThrow();
    expect(() =>
      mapPermissionResolution(
        { ...permission, choices: [{ id: 'mystery', label: 'Unknown' }] },
        { behavior: 'allow' }
      )
    ).toThrow();
    expect(
      mapPermissionResolution(
        {
          ...permission,
          choices: [
            { id: 'accept', label: 'Approve once' },
            { id: 'decline', label: 'Deny' },
          ],
        },
        { behavior: 'deny', message: 'no' }
      ).choice_id
    ).toBe('decline');
  });

  it('preserves updated arguments without granting unsupported persistent permissions', () => {
    expect(
      mapPermissionResolution(permission, {
        behavior: 'allow',
        updatedInput: { command: 'echo changed' },
      }).updated_arguments_json
    ).toEqual({ command: 'echo changed' });
    expect(() =>
      mapPermissionResolution(permission, { behavior: 'deny', message: 'no', interrupt: true })
    ).toThrow();
  });

  it('returns an explicit unsupported result for text questions', () => {
    expect(
      mapUserInputRequest({
        interaction_id: 'input-text',
        title: 'Note',
        questions: [{ id: 'q', prompt: 'Why?', kind: 'text' }],
      })
    ).toEqual({ kind: 'unsupported', reason: 'unsupported text question' });
  });

  it('maps user input questions to AskUserQuestion', () => {
    expect(
      mapUserInputRequest({
        interaction_id: 'input-1',
        title: 'Plan',
        questions: [
          {
            id: 'q1',
            prompt: 'Choose?',
            kind: 'single_choice',
            options: [
              { id: 'a', label: 'A' },
              { id: 'b', label: 'B' },
            ],
          },
        ],
      })
    ).toEqual({
      toolName: 'AskUserQuestion',
      toolUseID: 'input-1',
      input: {
        questions: [
          {
            question: 'Choose?',
            header: 'Plan',
            options: [
              { label: 'A', description: '' },
              { label: 'B', description: '' },
            ],
            multiSelect: false,
          },
        ],
      },
    });
  });
});
