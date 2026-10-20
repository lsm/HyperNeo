import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { WorkReadCursor, type WorkTurnPage } from '../../storage/work-turn-page.ts';
import { HandoffReference } from '../handoffs/outbox.ts';
import type { WorkTurn } from '../../storage/work-turns.ts';
import { defineOperation } from '../operations/registry.ts';
import type { RemoteDaemons } from './find-operation.ts';
import { workResultSchema, type Result } from './types.ts';
import { forwardWork, reject } from './work-operations.ts';

export const ReadWorkInputSchema = z
  .object({
    sessionId: z.string().min(1),
    daemon: z.string().min(1).optional(),
    around: z.string().min(1).optional(),
    cursor: WorkReadCursor.optional(),
    before: z.number().int().min(0).max(10).default(2),
    after: z.number().int().min(0).max(10).default(2),
  })
  .refine((input) => !input.cursor || input.cursor.sessionId === input.sessionId, {
    message: 'The cursor belongs to another session.',
    path: ['cursor'],
  });

export const ReadWorkResultSchema = workResultSchema(
  z.object({
    sessionId: z.string(),
    turns: z.array(
      z.object({
        messageId: z.string(),
        role: z.string(),
        at: z.number(),
        text: z.string(),
        textOffset: z.number().int().nonnegative().optional(),
        textComplete: z.boolean().optional(),
        files: z.array(HandoffReference).optional(),
      })
    ),
    availability: z.enum(['complete', 'incomplete', 'reply_unavailable']).optional(),
    nextCursor: WorkReadCursor.optional(),
  })
);

type ReadInput = z.infer<typeof ReadWorkInputSchema>;
type ReadResult = Result<{
  sessionId: string;
  turns: WorkTurn[];
  availability?: WorkTurnPage['availability'];
  nextCursor?: WorkTurnPage['nextCursor'];
}>;

export interface ReadWorkDeps {
  readTurns(
    sessionId: string,
    around: string | undefined,
    before: number,
    after: number,
    cursor?: z.infer<typeof WorkReadCursor>
  ): WorkTurn[] | WorkTurnPage | null;
  remote: RemoteDaemons;
  daemonName: string;
}

export function routeRead(
  input: ReadInput,
  deps: ReadWorkDeps
): { value: ReadInput } | { reason: Promise<ReadResult> } {
  if (!input.daemon || input.daemon === deps.daemonName) return { value: input };
  const { daemon, ...local } = input;
  return {
    reason: forwardWork(daemon, 'work.read', local, ReadWorkResultSchema, deps.remote).then(
      (result) =>
        input.cursor && result.ok && !result.value.availability
          ? reject('unsupported', 'The remote daemon does not support work.read cursors.')
          : result
    ),
  };
}

export function readLocalTurns(input: ReadInput, deps: ReadWorkDeps): ReadResult {
  const turns = deps.readTurns(
    input.sessionId,
    input.around,
    input.before,
    input.after,
    input.cursor
  );
  if (!turns) {
    return reject(
      'not_found',
      input.around
        ? `No message ${input.around} in session ${input.sessionId}.`
        : `No readable turns in session ${input.sessionId}.`
    );
  }
  if (!Array.isArray(turns)) return { ok: true, value: { sessionId: input.sessionId, ...turns } };
  if (input.cursor) return reject('unsupported', 'This driver does not support work.read cursors.');
  return { ok: true, value: { sessionId: input.sessionId, turns } };
}

const runReadWork = (superpipe({})('read-work') as PipelineAPI)
  .input(['input', 'deps'])
  .pipe(routeRead, ['input', 'deps'], 'result:outcome')
  .pipe(readLocalTurns, ['outcome', 'deps'], 'outcome')
  .endAsync('outcome') as (input: ReadInput, deps: ReadWorkDeps) => Promise<ReadResult>;

export function createReadWorkOperation(deps: ReadWorkDeps) {
  return defineOperation({
    name: 'work.read',
    description:
      'Read the user and agent turns of a session: sessionId, around (the messageId of a turn, such as one returned by an earlier work.read) and daemon (the place daemon, if any). Returns before turns earlier than the message, the message itself, and after turns later, oldest first; local HyperNeo reads preserve visible SDK text with availability and nextCursor. Pass nextCursor as cursor to continue long text or older history; textOffset identifies chunks. Empty or unlocated replies report reply_unavailable. External drivers keep their existing indexed excerpts. Without around, returns the latest turns.',
    inputSchema: ReadWorkInputSchema,
    resultSchema: ReadWorkResultSchema,
    policy: { safetyClass: 'read' },
    execute: (input) => runReadWork(input, deps),
  });
}
