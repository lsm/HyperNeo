import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { NeoPublicationRepository } from '../../storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import type { OperationCaller } from '../operations/registry.ts';

type Turn = NonNullable<OperationCaller['neoTurn']>;
type Reply = { requestId: string; shortText: string; fullText: string; links: [] };
type Deps = { db: Database; since: number; publish(reply: Reply): Promise<unknown> };

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function repliedThisTurn(turn: Turn | undefined, deps: Deps): boolean {
  const root = new NeoRepository(deps.db).defaultBinding();
  if (!turn || !root) return true;
  return (
    new NeoPublicationRepository(deps.db)
      .listRecent(root.sessionId.slice(4), 20)
      .some((publication) => publication.producerInput.messageId === turn.messageId) ||
    !!deps.db.prepare('SELECT 1 FROM neo_questions WHERE created_at >= ? LIMIT 1').get(deps.since)
  );
}

function neoTurnEndReply(
  turn: Turn | undefined,
  text: string | undefined,
  replied: boolean
): { value: Reply } | { reason: 'not_needed' } {
  const reply = text?.trim();
  return turn?.human && turn.isLive() && reply && !replied
    ? {
        value: {
          requestId: `turn-end:${turn.messageId}`,
          shortText: clip(reply, 2000),
          fullText: clip(reply, 16000),
          links: [],
        },
      }
    : { reason: 'not_needed' };
}

export const replyAtNeoTurnEnd = (superpipe({})('neo-turn-end-reply') as PipelineAPI)
  .input(['turn', 'text', 'deps'])
  .pipe(repliedThisTurn, ['turn', 'deps'], 'replied')
  .pipe(neoTurnEndReply, ['turn', 'text', 'replied'], 'result:reply')
  .pipe((reply: Reply, deps: Deps) => deps.publish(reply), ['reply', 'deps'], 'published')
  .endAsync('published') as (
  turn: Turn | undefined,
  text: string | undefined,
  deps: Deps
) => Promise<unknown>;
