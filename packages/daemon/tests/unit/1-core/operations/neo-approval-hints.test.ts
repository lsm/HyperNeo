import { describe, expect, test } from 'bun:test';
import type { NeoAsk, NeoQuestion } from '@hyperneo/shared/types/neo-ask';
import { noNeoInputReads, resolveNeoInputAsk } from '../../../../src/lib/neo/input-ask.ts';
import {
  proposalCardRecord,
  proposalQuestionId,
  requireAcceptedAsk,
} from '../../../../src/lib/neo/proposal.ts';
import type { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';

const ask = { id: 'ask-1', originMessageId: null } as unknown as NeoAsk;
const card = (state: NeoQuestion['state']): NeoQuestion =>
  ({
    id: proposalQuestionId(ask.id),
    askId: ask.id,
    state,
    answer: null,
    answeredBy: null,
  }) as unknown as NeoQuestion;

describe('approval hints', () => {
  test('a pending proposal names the open Do it card and says not to ask again', () => {
    const open = card('open');
    const result = requireAcceptedAsk(ask, open, [open], []);
    const reason = 'reason' in result ? result.reason.reason : '';
    expect(reason).toStartWith('ask_not_accepted:');
    expect(reason).toContain(open.id);
    expect(reason).toContain('do not open another card');
  });

  test('without an open proposal card the refusal stays generic', () => {
    const retired = card('retired');
    const result = requireAcceptedAsk(ask, retired, [retired], []);
    expect('reason' in result ? result.reason.reason : '').toBe(
      'ask_not_accepted: human approval is required before starting work.'
    );
  });

  test('the ask.open record names the proposal card', () => {
    expect(proposalCardRecord('q-1')).toStartWith('proposal_card:');
    expect(proposalCardRecord('q-1')).toContain('question q-1');
  });

  test('passing the message text as input says to pass the human-message id', async () => {
    const result = await resolveNeoInputAsk(
      {} as NeoAskTodoRepository,
      noNeoInputReads,
      { source: 'mcp', sessionId: 'neo:s' } as never,
      { input: '你派给 DeepSeek 去审' },
      'Review'
    );
    const reason = 'reason' in result ? result.reason.reason : '';
    expect(reason).toStartWith('unknown_input:');
    expect(reason).toContain('<human-message id="...">');
    expect(reason).toContain('not the message text');
  });
});
