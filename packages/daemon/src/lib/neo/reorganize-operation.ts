import { NEO_ASK_MOVED } from '@hyperneo/prompts';
import type { NeoBinding, NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoAskOrigin } from './ask-origin.ts';
import { NEO_INBOX_ID, type NeoRouted } from './router.ts';

const Input = z.object({}).default({});
const Stayed = z.object({
  askId: z.string(),
  reason: z.enum([
    'waiting_on_human',
    'changed',
    'stays_main',
    'one_off',
    'topic_busy',
    'handoff_failed',
  ]),
});
const Result = z.union([
  z.object({ ok: z.literal(false), reason: z.literal('main_neo_only') }),
  z.object({
    ok: z.literal(true),
    moved: z.array(z.object({ askId: z.string(), concernId: z.string() })),
    stayed: z.array(Stayed),
  }),
]);
type Stay = z.infer<typeof Stayed>;
type Outcome = z.infer<typeof Result>;
type Topic = { concernId: string; sessionId: string };
type Moved = { askId: string; concernId: string };

export interface NeoReorganizeRuntime {
  getBinding(sessionId: string): NeoBinding | null;
  rootSessionId(): string | null;
  liveAsks(): NeoAsk[];
  ask(id: string): NeoAsk | null;
  route(ask: NeoAsk): Promise<NeoRouted>;
  sessionStatus(sessionId: string): string | null;
  cards(ask: NeoAsk): NeoWork[];
  deliver(
    sessionId: string,
    messageId: string,
    content: string,
    fromSessionId: string,
    parent: NeoAskOrigin | null
  ): Promise<void>;
  move(ask: NeoAsk, cards: readonly NeoWork[], owner: Topic & { messageId: string }): void;
  log(line: string): void;
}

export function neoMovedAskMessageId(askId: string): string {
  return `neo-moved:${askId}`;
}

export function admitNeoReorganizer(
  caller: OperationCaller,
  binding: NeoBinding | null
): { value: true } | { reason: Outcome } {
  return (caller.source === 'rpc' && caller.principal === 'local') ||
    (caller.source === 'mcp' && binding?.kind === 'neo')
    ? { value: true }
    : { reason: { ok: false, reason: 'main_neo_only' } };
}

export function selectNeoMainAsks(asks: readonly NeoAsk[], root: string): NeoAsk[] {
  return asks.filter((ask) => ask.concernId === null && ask.originSessionId === root);
}

export function requireNeoAskMovable(ask: NeoAsk): { value: NeoAsk } | { reason: Stay } {
  return ask.status === 'open'
    ? { value: ask }
    : { reason: { askId: ask.id, reason: 'waiting_on_human' } };
}

export function requireNeoAskUnchanged(
  ask: NeoAsk,
  current: NeoAsk | null,
  root: string
): { value: NeoAsk } | { reason: Stay } {
  return current &&
    ['open', 'waiting', 'blocked'].includes(current.status) &&
    selectNeoMainAsks([current], root).length === 1
    ? { value: current }
    : { reason: { askId: ask.id, reason: 'changed' } };
}

export function requireNeoAskTopic(
  ask: NeoAsk,
  routed: NeoRouted
): { value: Topic } | { reason: Stay } {
  const choice = routed.choice;
  if (!choice) return { reason: { askId: ask.id, reason: 'stays_main' } };
  if (choice.concernId === NEO_INBOX_ID) return { reason: { askId: ask.id, reason: 'one_off' } };
  return { value: { concernId: choice.concernId, sessionId: choice.sessionId } };
}

export function requireNeoTopicIdle(
  ask: NeoAsk,
  topic: Topic,
  status: string | null
): { value: Topic } | { reason: Stay } {
  return status === null || status === 'idle'
    ? { value: topic }
    : { reason: { askId: ask.id, reason: 'topic_busy' } };
}

export function neoMovedAskNote(ask: NeoAsk, cards: readonly NeoWork[]): string {
  return `${NEO_ASK_MOVED}\n${JSON.stringify({
    askId: ask.id,
    title: ask.title,
    ask: ask.ask,
    status: ask.status,
    items: (ask.doneItems ?? [])
      .filter((item) => !item.removed)
      .map(({ id, text, state }) => ({ id, text, state })),
    ...(ask.doneItems?.length ? {} : { doneWhen: ask.doneWhen }),
    cards: cards.map(({ id, title, status }) => ({ id, title, status })),
  })}`;
}

export type NeoReorganized = { moved: Moved[]; stayed: Stay[] };

export function createNeoTopicsReorganizer(
  runtime: NeoReorganizeRuntime
): () => Promise<NeoReorganized> {
  const moveAsk = (superpipe({})('neo-topics-reorganize-ask') as PipelineAPI)
    .input(['ask', 'root'])
    .pipe(requireNeoAskMovable, 'ask', 'result:move')
    .pipe((ask: NeoAsk) => runtime.route(ask), 'ask', 'routed')
    .pipe((ask: NeoAsk) => runtime.ask(ask.id), 'ask', 'current')
    .pipe(requireNeoAskUnchanged, ['ask', 'current', 'root'], 'result:move')
    .pipe(requireNeoAskMovable, 'move', 'result:move')
    .pipe((current: NeoAsk) => current, 'move', 'fresh')
    .pipe(requireNeoAskTopic, ['fresh', 'routed'], 'result:move')
    .pipe(
      (ask: NeoAsk, topic: Topic) =>
        requireNeoTopicIdle(ask, topic, runtime.sessionStatus(topic.sessionId)),
      ['fresh', 'move'],
      'result:move'
    )
    .pipe((ask: NeoAsk) => runtime.cards(ask), 'fresh', 'cards')
    .pipe(
      async (ask: NeoAsk, root: string, topic: Topic, cards: NeoWork[]) => {
        const messageId = neoMovedAskMessageId(ask.id);
        await runtime.deliver(
          topic.sessionId,
          messageId,
          neoMovedAskNote(ask, cards),
          root,
          ask.originMessageId
            ? { sessionId: ask.originSessionId, messageId: ask.originMessageId }
            : null
        );
        runtime.move(ask, cards, { ...topic, messageId });
        runtime.log(
          `neo reorganize: moved ask ${ask.id} (${ask.title}) and ${cards.length} card(s) from main to ${topic.concernId}`
        );
        return { askId: ask.id, concernId: topic.concernId };
      },
      ['fresh', 'root', 'move', 'cards'],
      'move'
    )
    .endAsync('move') as (ask: NeoAsk, root: string) => Promise<Moved | Stay>;

  return async () => {
    const root = runtime.rootSessionId();
    const moved: Moved[] = [];
    const stayed: Stay[] = [];
    if (!root) return { moved, stayed };
    for (const ask of selectNeoMainAsks(runtime.liveAsks(), root)) {
      const result = await moveAsk(ask, root).catch((error: unknown) => {
        runtime.log(
          `neo reorganize: ask ${ask.id} stays with main, handoff failed: ${String(error)}`
        );
        return { askId: ask.id, reason: 'handoff_failed' as const };
      });
      if ('reason' in result) stayed.push(result);
      else moved.push(result);
    }
    return { moved, stayed };
  };
}

export function createNeoReorganizeOperation(runtime: NeoReorganizeRuntime) {
  const reorganizeTopics = createNeoTopicsReorganizer(runtime);
  const reorganize = async (caller: OperationCaller): Promise<Outcome> => {
    const admitted = admitNeoReorganizer(
      caller,
      caller.sessionId ? runtime.getBinding(caller.sessionId) : null
    );
    if ('reason' in admitted) return admitted.reason;
    return { ok: true, ...(await reorganizeTopics()) };
  };

  return defineOperation({
    name: 'neo.topics.reorganize',
    description:
      'Move each live ask that main owns into the topic it belongs to: an existing topic, or a new topic and avatar the daemon creates. The ask and its cards are handed to that topic’s avatar with a note, and replies still resolve to the human’s original message. Asks waiting on the human or blocked on them, asks that changed while routing, one-off asks, asks that stay with main, and asks whose topic avatar is mid-turn are left in place. Nothing is shown to the human; every move is logged. It also runs on its own about once a day, after the human has been away for three hours. Main Neo or the human only.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (_input, caller) => reorganize(caller),
  });
}
