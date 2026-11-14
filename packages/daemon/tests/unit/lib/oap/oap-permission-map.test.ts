import { describe, expect, it } from 'vitest';
import { mapUserInputRequest } from '../../../../src/lib/oap/oap-permission-map.ts';

describe('OAP interaction mapping', () => {
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
