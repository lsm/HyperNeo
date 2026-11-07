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
    title: 'Bash',
    arguments_json: { command: 'echo synthetic' },
    choices: [
      { id: 'approve', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ],
  };

  it('maps permission requests and both decisions', () => {
    expect(mapPermissionRequest(permission)).toEqual({
      toolName: 'Bash',
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
    });
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
