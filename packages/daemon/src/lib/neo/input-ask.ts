import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAsk, NeoReplyTo } from '@hyperneo/shared/types/neo-ask';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { readNeoReply } from './intake.ts';

export type NeoInputReads = {
  input(caller: OperationCaller, id: string): NeoConversationAsk | null;
  publication(id: string): NeoPublication | null;
};

export const noNeoInputReads: NeoInputReads = { input: () => null, publication: () => null };

type Binding = { value: { askId: string } } | { reason: { ok: false; reason: string } };

const words = (content: NeoConversationAsk['content']) =>
  typeof content === 'string'
    ? content
    : content
        .flatMap((block: { type: string; text?: string }) =>
          block.type === 'text' && block.text ? [block.text] : []
        )
        .join('\n');

function repliedAskId(
  store: NeoAskTodoRepository,
  reads: NeoInputReads,
  sessionId: string,
  replyTo: NeoReplyTo
): string | null {
  if (replyTo.kind !== 'message') return readNeoReply(replyTo, store)?.ask?.id ?? null;
  if (replyTo.author === 'user') return store.findAsk(sessionId, replyTo.id, null)?.id ?? null;
  const told = reads.publication(replyTo.id);
  const origin =
    told?.askOrigin && store.findAsk(told.askOrigin.sessionId, told.askOrigin.messageId, null);
  return told?.cardReply?.askId ?? origin?.id ?? null;
}

type Request = { input?: string; askId?: string; sessionId: string };
type Plan = { use: string } | { bind: string } | { open: true } | { refuse: string };
const mismatch = (input: string | undefined, owner: string, target: string) =>
  `ask_mismatch: input ${input} belongs to ask ${owner}, not ${target}. Use the owning ask.`;
const settled = 'ask_settled: this ask is no longer open. Omit askId to open a new card.';

export function planNeoInputAsk(
  facts: {
    replyOwner: string | null;
    originAsk: NeoAsk | null;
    boundAsk: string | null;
    target: NeoAsk | null;
  },
  request: Request
): Plan {
  const owner = facts.replyOwner ?? facts.originAsk?.id ?? facts.boundAsk;
  if (owner && request.askId && request.askId !== owner)
    return { refuse: mismatch(request.input, owner, request.askId) };
  if (!request.askId) return owner ? { use: owner } : { open: true };
  if (!facts.target || facts.target.sessionId !== request.sessionId)
    return { refuse: 'not_owned: this ask is unknown or belongs to another session.' };
  if (facts.target.status !== 'open') return { refuse: settled };
  return owner ? { use: owner } : { bind: request.askId };
}

const neoInputAsk = (superpipe({})('neo.input.ask') as PipelineAPI)
  .input(['facts', 'request', 'claim'])
  .pipe(planNeoInputAsk, ['facts', 'request'], 'plan')
  .pipe(
    (plan: Plan, claim: (plan: Plan) => Promise<Binding>) => claim(plan),
    ['plan', 'claim'],
    'binding'
  )
  .endAsync('binding');

export async function resolveNeoInputAsk(
  store: NeoAskTodoRepository,
  reads: NeoInputReads,
  caller: OperationCaller,
  request: { input?: string; askId?: string },
  title: string
): Promise<Binding> {
  if (!request.input)
    return request.askId
      ? { value: { askId: request.askId } }
      : {
          reason: {
            ok: false,
            reason:
              'input_required: pass input, the [message id] of the human message this serves.',
          },
        };
  const human = reads.input(caller, request.input);
  if (!human)
    return {
      reason: {
        ok: false,
        reason: `unknown_input: ${request.input} is not a human message you received.`,
      },
    };
  const { sessionId, messageId } = human.askOrigin;
  const facts = {
    replyOwner: human.replyTo ? repliedAskId(store, reads, sessionId, human.replyTo) : null,
    originAsk: store.findAsk(sessionId, messageId, null),
    boundAsk: await store.findAskInput(sessionId, messageId),
    target: request.askId ? store.getAsk(request.askId) : null,
  };
  return neoInputAsk(facts, { ...request, sessionId }, async (plan: Plan): Promise<Binding> => {
    if ('refuse' in plan) return { reason: { ok: false, reason: plan.refuse } };
    if ('use' in plan) return { value: { askId: plan.use } };
    const winner = await store.claimNeoInputAsk({
      sessionId,
      messageId,
      ...('bind' in plan ? { askId: plan.bind } : {}),
      title:
        title
          .split('\n')[0]
          .replace(/^[#*\s]+|\*+/g, '')
          .slice(0, 120) || title,
      request: words(human.content) || title,
    });
    if (typeof winner !== 'string') return { reason: { ok: false, reason: winner.reason } };
    if ('bind' in plan && winner !== plan.bind)
      return { reason: { ok: false, reason: mismatch(request.input, winner, plan.bind) } };
    return { value: { askId: winner } };
  }) as Promise<Binding>;
}
