import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { NeoRepository } from '../../storage/repositories/neo-repository.ts';
import type { OperationCaller } from '../operations/registry.ts';
import { neoHumanTrigger } from './notification-triggers.ts';

type Turn = NonNullable<OperationCaller['neoTurn']>;
type Reply = {
  requestId: string;
  triggerId: string;
  shortText: string;
  fullText: string;
  links: [];
};
type Deps = { db: Database; since: number; publish(reply: Reply): Promise<unknown> };

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

function repliedThisTurn(answer: string | undefined, deps: Deps): boolean {
  const root = new NeoRepository(deps.db).defaultBinding();
  if (!answer || !root) return true;
  return !!(
    deps.db
      .prepare(
        `SELECT 1 FROM neo_publications WHERE conversation_id = ? AND instr(payload_json, ?) > 0
         LIMIT 1`
      )
      .get(root.sessionId.slice(4), JSON.stringify({ messageId: answer }).slice(1, -1)) ||
    deps.db
      .prepare("SELECT 1 FROM neo_questions WHERE state = 'open' AND created_at >= ? LIMIT 1")
      .get(deps.since)
  );
}

function neoTurnEndReply(
  turn: Turn | undefined,
  answer: string | undefined,
  text: string | undefined,
  replied: boolean
): { value: Reply } | { reason: 'not_needed' } {
  const reply = text?.trim();
  return turn?.isLive() && answer && reply && !replied
    ? {
        value: {
          requestId: `turn-end:${answer}`,
          triggerId: neoHumanTrigger(answer),
          shortText: clip(reply, 2000),
          fullText: clip(reply, 16000),
          links: [],
        },
      }
    : { reason: 'not_needed' };
}

export const replyAtNeoTurnEnd = (superpipe({})('neo-turn-end-reply') as PipelineAPI)
  .input(['turn', 'answer', 'text', 'deps'])
  .pipe(repliedThisTurn, ['answer', 'deps'], 'replied')
  .pipe(neoTurnEndReply, ['turn', 'answer', 'text', 'replied'], 'result:reply')
  .pipe((reply: Reply, deps: Deps) => deps.publish(reply), ['reply', 'deps'], 'published')
  .endAsync('published') as (
  turn: Turn | undefined,
  answer: string | undefined,
  text: string | undefined,
  deps: Deps
) => Promise<unknown>;
