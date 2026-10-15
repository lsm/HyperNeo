import { fillPrompt, NEO_ASK_FORWARDED } from '@hyperneo/prompts';
import type { NeoBinding, NeoProject } from '@hyperneo/shared/types/neo-context';
import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { NeoAskForward } from '../../storage/repositories/neo-ask-forward-repository.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoAskOrigin } from './ask-origin.ts';
import { isNeoCoordinatorBinding } from './binding-roles.ts';

const Input = z.object({ to: z.string().trim().min(1) });
const Rejection = z.object({
  ok: z.literal(false),
  reason: z.enum([
    'coordinator_only',
    'unknown_ask',
    'not_your_ask',
    'same_project',
    'main_only',
    'forward_limit',
    'unknown_project',
  ]),
  projects: z
    .array(z.object({ id: z.string(), title: z.string() }))
    .max(50)
    .optional(),
});
const Result = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), hop: z.number().int(), to: z.string() }),
  Rejection,
]);
type Input = z.infer<typeof Input>;
type Outcome = z.infer<typeof Result>;
type Refusal = z.infer<typeof Rejection>;
type Gate<T> = { value: T } | { reason: Refusal };
type Holder = { sessionId: string; projectId: string | null; input: NeoAskOrigin };
type Plan = { hop: number; to: string };
type Target = Plan & { title: string };

export const NEO_FORWARD_MAIN = 'main';

export interface NeoAskForwardRuntime {
  getBinding(sessionId: string): NeoBinding | null;
  resolveAskOrigin(input: NeoAskOrigin): NeoAskOrigin | null;
  forwards(ask: NeoAskOrigin): NeoAskForward[];
  getProject(id: string): Pick<NeoProject, 'id' | 'title'> | null;
  listProjects(): Pick<NeoProject, 'id' | 'title'>[];
  rootSessionId(): string | null;
  askText(ask: NeoAskOrigin): string | null;
  open(projectId: string): Promise<string>;
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
  if (typeof ask.content === 'string') return ask.content.trim() || null;
  const blocks = ask.content as { type: string; text?: string }[];
  const text = blocks
    .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
    .join('\n')
    .trim();
  const attached = blocks.filter((block) => block.type !== 'text').length;
  const note = attached
    ? `(The human also attached ${attached} file${attached === 1 ? '' : 's'}, not forwarded; ask them to resend it if you need it.)`
    : '';
  return [text, note].filter(Boolean).join('\n\n') || null;
}

export function neoForwardedAskMessageId(messageId: string): string | null {
  return /^neo-forward:(.+):\d+$/.exec(messageId)?.[1] ?? null;
}

export function neoForwardHop(messageId: string): number | null {
  const hop = /^neo-forward:.+:(\d+)$/.exec(messageId)?.[1];
  return hop === undefined ? null : Number(hop);
}

export function neoTurnOwnsMessage(
  sessionId: string,
  turn: { messageId: string; human: boolean; consultationId?: string },
  forwards: readonly Pick<NeoAskForward, 'hop' | 'toSessionId'>[]
): boolean {
  if (turn.consultationId) return false;
  const last = forwards.reduce<Pick<NeoAskForward, 'hop' | 'toSessionId'> | null>(
    (latest, forward) => (!latest || forward.hop > latest.hop ? forward : latest),
    null
  );
  const hop = neoForwardHop(turn.messageId);
  if (hop === null) return turn.human && !last;
  return !!last && last.hop === hop && last.toSessionId === sessionId;
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
    isNeoCoordinatorBinding(binding) &&
    binding.sessionId === caller.sessionId &&
    turn?.messageId &&
    turn.isLive()
    ? {
        value: {
          sessionId: binding.sessionId,
          projectId: binding.projectId ?? null,
          input: { sessionId: binding.sessionId, messageId: turn.messageId },
        },
      }
    : refuse('coordinator_only');
}

export function requireForwardedAsk(ask: NeoAskOrigin | null): Gate<NeoAskOrigin> {
  return ask ? { value: ask } : refuse('unknown_ask');
}

export function planNeoAskForward(
  input: Input,
  holder: Pick<Holder, 'sessionId' | 'projectId' | 'input'>,
  ask: NeoAskOrigin,
  forwards: readonly Pick<NeoAskForward, 'toSessionId' | 'fromSessionId'>[],
  main: string | null = null
): Gate<Plan> {
  if (forwards.length === 0) {
    if (ask.sessionId !== holder.sessionId || holder.input.messageId !== ask.messageId)
      return refuse('not_your_ask');
    return input.to === (holder.projectId ?? NEO_FORWARD_MAIN)
      ? refuse('same_project')
      : { value: { hop: 0, to: input.to } };
  }
  const viaMain = forwards.some((f) => f.fromSessionId === main || f.toSessionId === main);
  if (forwards.length === 1 && viaMain) return refuse('forward_limit');
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
  project: Pick<NeoProject, 'id' | 'title'> | null,
  projects: readonly Pick<NeoProject, 'id' | 'title'>[]
): Gate<Target> {
  if (plan.to === NEO_FORWARD_MAIN) return { value: { ...plan, title: 'main' } };
  return project
    ? { value: { ...plan, title: project.title } }
    : {
        reason: {
          ok: false,
          reason: 'unknown_project',
          projects: projects.slice(0, 50).map(({ id, title }) => ({ id, title })),
        },
      };
}

export function neoForwardContent(from: string, mayForward: boolean, message: string): string {
  return fillPrompt(NEO_ASK_FORWARDED, {
    from: `“${from}”`,
    next: mayForward
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
    .pipe(
      (input: Input, holder: Holder, ask: NeoAskOrigin, forwards: NeoAskForward[]) =>
        planNeoAskForward(input, holder, ask, forwards, runtime.rootSessionId()),
      ['input', 'holder', 'ask', 'forwards'],
      'result:outcome'
    )
    .pipe(take, 'outcome', 'plan')
    .pipe(
      (plan: Plan) => (plan.to === NEO_FORWARD_MAIN ? null : runtime.getProject(plan.to)),
      'plan',
      'project'
    )
    .pipe(
      (plan: Plan, project: Pick<NeoProject, 'id' | 'title'> | null) =>
        requireForwardTarget(plan, project, project ? [] : runtime.listProjects()),
      ['plan', 'project'],
      'result:outcome'
    )
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
        return sessionId ? { value: sessionId } : refuse('unknown_project');
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
          toProjectId: target.to === NEO_FORWARD_MAIN ? null : target.to,
          forwardedAt: Date.now(),
        });
        if (!recorded) return { ok: false, reason: 'forward_limit' };
        const from = holder.projectId
          ? (runtime.getProject(holder.projectId)?.title ?? holder.projectId)
          : NEO_FORWARD_MAIN;
        try {
          await runtime.deliver(
            session,
            neoForwardMessageId(ask, target.hop),
            neoForwardContent(
              from,
              target.hop === 0 && target.to !== NEO_FORWARD_MAIN && holder.projectId !== null,
              message
            ),
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
      'Hand the human message you are answering to the project that owns it, when it is clearly not your subject; the receiver then owns the message, answers it and may start its work. to is that project id, or "main"; an unknown id is refused with the list of projects, so call again with the right one. Main may forward once, to a project, and that project cannot forward it on. The routed holder may forward once, to another project or main; a holder that received a forward from a holder may forward only to main. Nothing forwards back. End your turn without answering after forwarding.',
    inputSchema: Input,
    resultSchema: Result,
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    execute: (input, caller) => forward(input, caller),
  });
}
