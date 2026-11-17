import superpipe, { type PipelineAPI } from 'superpipe';
import { gatewayFor } from '../../../storage/db-gateway/db-gateway.ts';
import { JobQueueRepository } from '../../../storage/repositories/job-queue-repository.ts';
import { neoWakeQueueWrite } from '../../../storage/repositories/neo-wake-queue-repository.ts';
import type { Database } from '../../../storage/sqlite-compat.ts';
import { mailSessionEvent } from '../../external-events/session-event-delivery.ts';
import { renderAddress } from '../../mailbox/address.ts';
import { createMailboxEntry } from '../../mailbox/entry.ts';
import {
  decideNeoAttention,
  type NeoAttentionEvent,
  type NeoAttentionKind,
  type NeoAttentionKnown,
  neoAttentionUuid,
  renderNeoAttention,
} from './decide.ts';

type Deliver = (uuid: string, text: string, event: NeoAttentionEvent) => Promise<boolean>;

export type NeoAttentionOutcome =
  | { told: 'wake' | 'digest'; step: number; uuid: string; text: string }
  | { dropped: string };

export const neoAttentionDelivery = (
  db: Database,
  session: () => string | null,
  busy: (sessionId: string) => boolean
): { wake: (uuid: string, text: string) => Promise<boolean>; digest: Deliver } => ({
  wake: async (uuid, text) => {
    const sessionId = session();
    if (!sessionId) return false;
    const outcome = await mailSessionEvent(new JobQueueRepository(db), {
      sessionId,
      messageUuid: uuid,
      text,
      mode: busy(sessionId) ? 'defer' : 'immediate',
    });
    if (outcome.kind === 'rejected') throw new Error(`Neo wake was not queued: ${outcome.reason}`);
    return true;
  },
  digest: async (uuid, text, event) => {
    const sessionId = session();
    if (!sessionId) return false;
    await gatewayFor(db).call(
      neoWakeQueueWrite,
      'holdOnce',
      createMailboxEntry({
        to: { kind: 'session', sessionId },
        origin: renderAddress({ kind: 'session', sessionId }),
        messageUuid: uuid,
        message: {
          type: 'user',
          parent_tool_use_id: null,
          message: { content: text },
          inputKind: 'system',
        },
      }),
      `${event.kind}:${event.subject.id}`
    );
    return true;
  },
});

export function createNeoAttention(deps: {
  kinds(): readonly NeoAttentionKind[];
  read(event: NeoAttentionEvent): NeoAttentionKnown | Promise<NeoAttentionKnown>;
  wake: Deliver;
  digest: Deliver;
  dropped(event: NeoAttentionEvent, reason: string): void;
}) {
  return (superpipe({})('neo.attention.tell') as PipelineAPI)
    .input(['event', 'now'])
    .pipe(deps.read, 'event', 'known')
    .pipe(
      (event: NeoAttentionEvent, known: NeoAttentionKnown, now: number) => {
        const decision = decideNeoAttention(event, known, now, deps.kinds());
        if ('value' in decision) return decision;
        deps.dropped(event, decision.reason);
        return { reason: { dropped: decision.reason } };
      },
      ['event', 'known', 'now'],
      'result:outcome'
    )
    .pipe(
      (event: NeoAttentionEvent, decided: { action: 'wake' | 'digest'; step: number }) => {
        const text = renderNeoAttention(event, deps.kinds());
        const uuid = neoAttentionUuid(event, decided.step, text);
        return { told: decided.action, step: decided.step, uuid, text };
      },
      ['event', 'outcome'],
      'message'
    )
    .pipe(
      async (event: NeoAttentionEvent, message: Extract<NeoAttentionOutcome, { told: string }>) => {
        if (!(await deps[message.told](message.uuid, message.text, event)))
          return { dropped: 'no_session' };
        deps
          .kinds()
          .find((kind) => kind.id === event.kind)
          ?.sent?.(event);
        return message;
      },
      ['event', 'message'],
      'outcome'
    )
    .endAsync('outcome') as (event: NeoAttentionEvent, now: number) => Promise<NeoAttentionOutcome>;
}
