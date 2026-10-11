import { fillPrompt, NEO_ASK_FORWARDED } from '@hyperneo/prompts';
import type { NeoBinding, NeoConcern } from '@hyperneo/shared/types/neo-context';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoAskForward } from '../../storage/repositories/neo-ask-forward-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoAskOrigin } from './ask-origin.ts';

const Input = z.object({ to: z.string().trim().min(1) });
const Rejection = z.object({
  ok: z.literal(false),
  reason: z.enum([
    'topic_holder_only',
    'unknown_ask',
    'not_your_ask',
    'same_topic',
    'main_only',
    'forward_limit',
    'unknown_topic',
  ]),
});
const Result = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), hop: z.number().int(), to: z.string() }),
  Rejection,
]);
type Input = z.infer<typeof Input>;
type Outcome = z.infer<typeof Result>;
type Refusal = z.infer<typeof Rejection>;
type Gate<T> = { value: T } | { reason: Refusal };
type Holder = { sessionId: string; concernId: string; input: NeoAskOrigin };
type Plan = { hop: number; to: string };
type Target = Plan & { title: string };

export const NEO_FORWARD_MAIN = 'main';

export interface NeoAskForwardRuntime {
  getBinding(sessionId: string): NeoBinding | null;
  resolveAskOrigin(input: NeoAskOrigin): NeoAskOrigin | null;
  forwards(ask: NeoAskOrigin): NeoAskForward[];
  getConcern(id: string): Pick<NeoConcern, 'id' | 'title'> | null;
  rootSessionId(): string | null;
  askText(ask: NeoAskOrigin): string | null;
  open(concernId: string): Promise<string>;
  record(ask: NeoAskOrigin, forward: NeoAskForward): boolean;
  unrecord(ask: NeoAskOrigin, hop: number): void;
  delivered(sessionId: string, messageId: string): boolean;
  deliver(
    sessionId: string,
    messageId: string,
    content: string,
    fromSessionId: string,
    ask: NeoAskOrigin
  ): Promise<void>;
}

const refuse = (reason: Refusal['reason']): { reason: Refusal } => ({
  reason: { ok: false, reason },
});

export function neoForwardedText(
  ask: Pick<NeoConversationAsk, 'askOrigin' | 'content'> | null,
  origin: NeoAskOrigin
): string | null {
  if (!ask || ask.askOrigin.sessionId !== origin.sessionId) return null;
  const text =
    typeof ask.content === 'string'
      ? ask.content
      : ask.content
          .flatMap((block: { type: string; text?: string }) =>
            block.type === 'text' && block.text ? [block.text] : []
          )
          .join('\n');
  return text.trim() || null;
}

export function neoForwardMessageId(ask: NeoAskOrigin, hop: number): string {
  return `neo-forward:${ask.messageId}:${hop}`;
}

export function staleNeoForwardHops(
  ask: NeoAskOrigin,
  forwards: readonly Pick<NeoAskForward, 'hop' | 'toSessionId'>[],
  delivered: (sessionId: string, messageId: string) => boolean
): number[] {
  return forwards
    .filter((forward) => !delivered(forward.toSessionId, neoForwardMessageId(ask, forward.hop)))
    .map((forward) => forward.hop);
}

export function requireForwardingHolder(
  caller: OperationCaller,
  binding: NeoBinding | null
): Gate<Holder> {
  const turn = caller.neoTurn;
  return caller.source === 'mcp' &&
    binding?.kind === 'concern' &&
    binding.concernId &&
    binding.sessionId === caller.sessionId &&
    turn?.messageId &&
    turn.isLive()
    ? {
        value: {
          sessionId: binding.sessionId,
          concernId: binding.concernId,
          input: { sessionId: binding.sessionId, messageId: turn.messageId },
        },
      }
    : refuse('topic_holder_only');
}

export function requireForwardedAsk(ask: NeoAskOrigin | null): Gate<NeoAskOrigin> {
  return ask ? { value: ask } : refuse('unknown_ask');
}

export function planNeoAskForward(
  input: Input,
  holder: Pick<Holder, 'sessionId' | 'concernId' | 'input'>,
  ask: NeoAskOrigin,
  forwards: readonly Pick<NeoAskForward, 'toSessionId'>[]
): Gate<Plan> {
  if (forwards.length === 0) {
    if (ask.sessionId !== holder.sessionId || holder.input.messageId !== ask.messageId)
      return refuse('not_your_ask');
    return input.to === holder.concernId
      ? refuse('same_topic')
      : { value: { hop: 0, to: input.to } };
  }
  if (forwards.length === 1) {
    if (
      forwards[0].toSessionId !== holder.sessionId ||
      holder.input.messageId !== neoForwardMessageId(ask, 0)
    )
      return refuse('not_your_ask');
    return input.to === NEO_FORWARD_MAIN
      ? { value: { hop: 1, to: NEO_FORWARD_MAIN } }
      : refuse('main_only');
  }
  return refuse('forward_limit');
}

export function requireForwardTarget(
  plan: Plan,
  concern: Pick<NeoConcern, 'id' | 'title'> | null
): Gate<Target> {
  if (plan.to === NEO_FORWARD_MAIN) return { value: { ...plan, title: 'main' } };
  return concern ? { value: { ...plan, title: concern.title } } : refuse('unknown_topic');
}

export function neoForwardContent(from: string, hop: number, message: string): string {
  return fillPrompt(NEO_ASK_FORWARDED, {
    from: `“${from}”`,
    next:
      hop === 0
        ? ' If it is not your subject either, forward it to main with neo.ask.forward {"to":"main"}; it can go nowhere else.'
        : '',
    message,
  });
}

function createForward(runtime: NeoAskForwardRuntime) {
  const take = <T>(value: T) => value;
  return (superpipe({})('neo-ask-forward') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) => runtime.getBinding(caller.sessionId ?? ''),
      'caller',
      'binding'
    )
    .pipe(requireForwardingHolder, ['caller', 'binding'], 'result:outcome')
    .pipe(take, 'outcome', 'holder')
    .pipe((holder: Holder) => runtime.resolveAskOrigin(holder.input), 'holder', 'resolved')
    .pipe(requireForwardedAsk, 'resolved', 'result:outcome')
    .pipe(take, 'outcome', 'ask')
    .pipe(
      (ask: NeoAskOrigin) => {
        const forwards = runtime.forwards(ask);
        const stale = staleNeoForwardHops(ask, forwards, (sessionId, messageId) =>
          runtime.delivered(sessionId, messageId)
        );
        for (const hop of stale) runtime.unrecord(ask, hop);
        return forwards.filter((forward) => !stale.includes(forward.hop));
      },
      'ask',
      'forwards'
    )
    .pipe(planNeoAskForward, ['input', 'holder', 'ask', 'forwards'], 'result:outcome')
    .pipe(take, 'outcome', 'plan')
    .pipe(
      (plan: Plan) => (plan.to === NEO_FORWARD_MAIN ? null : runtime.getConcern(plan.to)),
      'plan',
      'concern'
    )
    .pipe(requireForwardTarget, ['plan', 'concern'], 'result:outcome')
    .pipe(take, 'outcome', 'target')
    .pipe((ask: NeoAskOrigin) => runtime.askText(ask), 'ask', 'text')
    .pipe(
      (text: string | null): Gate<string> => (text ? { value: text } : refuse('unknown_ask')),
      'text',
      'result:outcome'
    )
    .pipe(take, 'outcome', 'message')
    .pipe(
      async (target: Target): Promise<Gate<string>> => {
        const sessionId =
          target.to === NEO_FORWARD_MAIN ? runtime.rootSessionId() : await runtime.open(target.to);
        return sessionId ? { value: sessionId } : refuse('unknown_topic');
      },
      'target',
      'result:outcome'
    )
    .pipe(take, 'outcome', 'session')
    .pipe(
      async (
        target: Target,
        session: string,
        holder: Holder,
        ask: NeoAskOrigin,
        message: string
      ): Promise<Outcome> => {
        const recorded = runtime.record(ask, {
          hop: target.hop,
          fromSessionId: holder.sessionId,
          toSessionId: session,
          toConcernId: target.to === NEO_FORWARD_MAIN ? null : target.to,
          forwardedAt: Date.now(),
        });
        if (!recorded) return { ok: false, reason: 'forward_limit' };
        const from = runtime.getConcern(holder.concernId)?.title ?? holder.concernId;
        try {
          await runtime.deliver(
            session,
            neoForwardMessageId(ask, target.hop),
            neoForwardContent(from, target.hop, message),
            holder.sessionId,
            ask
          );
        } catch (error) {
          runtime.unrecord(ask, target.hop);
          throw error;
        }
        return { ok: true, hop: target.hop, to: target.to };
      },
      ['target', 'session', 'holder', 'ask', 'message'],
      'outcome'
    )
    .endAsync('outcome') as (input: Input, caller: OperationCaller) => Promise<Outcome>;
}

export function createNeoAskForwardOperation(runtime: NeoAskForwardRuntime) {
  const forward = createForward(runtime);
  return defineOperation({
    name: 'neo.ask.forward',
    description:
      'From a topic holder, hand the human message you are answering to the topic that knows it, when it is clearly not your subject. to is that topic id from neo.snapshot, or "main". The routed holder may forward once, to another topic or main; a holder that received a forward may forward only to main. Nothing forwards back. End your turn without answering after forwarding.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input, caller) => forward(input, caller),
  });
}
