import type { NeoService } from '../../../src/lib/neo/service.ts';
import type { OperationCaller } from '../../../src/lib/operations/registry.ts';

export function withNeoProposalAsk(
  service: Pick<NeoService, 'askRecords'>,
  name: string,
  input: unknown,
  caller: OperationCaller
): unknown {
  const turn = caller.neoTurn;
  if (
    name !== 'neo.work.propose' ||
    caller.source !== 'mcp' ||
    !caller.sessionId ||
    !turn ||
    !input ||
    typeof input !== 'object' ||
    'askId' in input
  )
    return input;
  const requestKey = `test-ask:${caller.sessionId}:${turn.messageId}`;
  const ask =
    service.askRecords.forRequest(requestKey) ??
    service.askRecords.open({
      id: crypto.randomUUID(),
      requestKey,
      projectId: (input as { projectId?: string | null }).projectId ?? null,
      originSessionId: caller.sessionId,
      originMessageId: turn.messageId,
      title: 'Proposed work',
      ask: 'Proposed work',
      doneWhen: '',
      doneSource: 'human',
    });
  return ask ? { ...input, askId: ask.id } : input;
}

export function approveNeoProposalQuestion(
  service: Pick<NeoService, 'askRecords'>,
  workId: string
): void {
  const ask = service.askRecords.forWork(workId);
  const question = ask?.doneItems?.find(
    (item) => !item.removed && item.action?.startsWith('neo-start:')
  );
  if (!ask || !question) throw new Error('Expected a grouped start question in the fixture');
  if (question.state === 'met' && question.metBy === 'human') return;
  service.askRecords.tickItem(
    ask.id,
    {
      ...question,
      state: 'met',
      metBy: 'human',
      evidence: `The human answered: ${question.options!.at(-1)}`,
    },
    Date.now(),
    question,
    true
  );
}
