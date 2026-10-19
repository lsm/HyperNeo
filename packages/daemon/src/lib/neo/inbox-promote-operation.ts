import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { handOffNeoAsk, type NeoReorganizeRuntime } from './reorganize-operation.ts';
import { NEO_INBOX_ID, type NeoHolder } from './inbox.ts';

const Input = z.object({
  title: z.string().trim().min(1).max(120),
  askIds: z.array(z.string().min(1)).min(1).max(20),
});
const Result = z.union([
  z.object({ ok: z.literal(false), reason: z.string() }),
  z.object({
    ok: z.literal(true),
    projectId: z.string(),
    moved: z.array(z.string()),
    stayed: z.array(z.string()),
  }),
]);
type Refusal = { ok: false; reason: string };
type Gate<T> = { value: T } | { reason: Refusal };

const refuse = (reason: string): { reason: Refusal } => ({ reason: { ok: false, reason } });
const LIVE = new Set(['open', 'waiting', 'blocked']);
const DAY_MS = 24 * 60 * 60 * 1000;
export const NEO_RECURRING_ASKS = 3;

export interface NeoInboxPromoteRuntime
  extends Pick<NeoReorganizeRuntime, 'getBinding' | 'ask' | 'cards' | 'deliver' | 'move' | 'log'> {
  createProject(title: string): Promise<NeoHolder | null>;
}

export function requireNeoInboxHolder(
  caller: OperationCaller,
  binding: NeoBinding | null
): Gate<string> {
  return caller.source === 'mcp' &&
    binding?.projectId === NEO_INBOX_ID &&
    binding.sessionId === caller.sessionId &&
    caller.neoTurn?.isLive()
    ? { value: binding.sessionId }
    : refuse('inbox_only');
}

export function requireNeoInboxAsks(
  ids: readonly string[],
  asks: readonly (NeoAsk | null)[]
): Gate<NeoAsk[]> {
  const stray = ids.find(
    (id, index) =>
      ids.indexOf(id) !== index ||
      asks[index]?.projectId !== NEO_INBOX_ID ||
      !LIVE.has(asks[index]?.status ?? '')
  );
  return stray === undefined
    ? { value: asks as NeoAsk[] }
    : refuse(`not_an_inbox_ask: ${stray} is not a live Inbox ask, or is listed twice.`);
}

export function isNeoRecurringTopic(asks: readonly Pick<NeoAsk, 'createdAt'>[]): boolean {
  const days = new Set(asks.map((ask) => Math.floor(ask.createdAt / DAY_MS)));
  return days.size > 1 || asks.length >= NEO_RECURRING_ASKS;
}

export function requireNeoRecurringTopic(asks: NeoAsk[]): Gate<NeoAsk[]> {
  return isNeoRecurringTopic(asks)
    ? { value: asks }
    : refuse(
        `not_recurring: a topic gets its own project once it comes up on more than one day or in ${NEO_RECURRING_ASKS} asks. Keep answering it here until then.`
      );
}

export function createNeoInboxPromoteOperation(runtime: NeoInboxPromoteRuntime) {
  const take = <T>(value: T) => value;
  const promote = (superpipe({})('neo.inbox.promote') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(
      (caller: OperationCaller) => runtime.getBinding(caller.sessionId ?? ''),
      'caller',
      'binding'
    )
    .pipe(requireNeoInboxHolder, ['caller', 'binding'], 'result:promote')
    .pipe(take, 'promote', 'inbox')
    .pipe(
      (input: z.infer<typeof Input>) => input.askIds.map((id) => runtime.ask(id)),
      'input',
      'asks'
    )
    .pipe(
      (input: z.infer<typeof Input>, asks: (NeoAsk | null)[]) =>
        requireNeoInboxAsks(input.askIds, asks),
      ['input', 'asks'],
      'result:promote'
    )
    .pipe(requireNeoRecurringTopic, 'promote', 'result:promote')
    .pipe(take, 'promote', 'topic')
    .pipe(
      async (input: z.infer<typeof Input>) => ({
        project: await runtime.createProject(input.title),
      }),
      'input',
      'created'
    )
    .pipe(
      (created: { project: NeoHolder | null }): Gate<NeoHolder> =>
        created.project ? { value: created.project } : refuse('project_unavailable'),
      'created',
      'result:promote'
    )
    .pipe(
      async (topic: NeoAsk[], inbox: string, project: NeoHolder) => {
        const moved: string[] = [];
        const stayed: string[] = [];
        for (const ask of topic) {
          const current = requireNeoInboxAsks([ask.id], [runtime.ask(ask.id)]);
          const handedOff =
            'value' in current &&
            (await handOffNeoAsk(
              runtime,
              current.value[0],
              inbox,
              project,
              runtime.cards(current.value[0])
            ).then(
              () => true,
              () => false
            ));
          (handedOff ? moved : stayed).push(ask.id);
        }
        return { ok: true as const, projectId: project.projectId, moved, stayed };
      },
      ['topic', 'inbox', 'promote'],
      'promote'
    )
    .endAsync('promote') as (
    input: z.infer<typeof Input>,
    caller: OperationCaller
  ) => Promise<z.infer<typeof Result>>;
  return defineOperation({
    name: 'neo.inbox.promote',
    description:
      'From the Inbox, give a recurring topic its own project. Pass a short title and the askIds of that topic’s Inbox asks; they must come from more than one day or number at least three. The daemon creates the project and its holder, moves those asks and their cards there with their history, and later messages about the topic route there. An ask that changed meanwhile or failed to move is listed in stayed and remains in the Inbox.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input, caller) => promote(input, caller),
  });
}
