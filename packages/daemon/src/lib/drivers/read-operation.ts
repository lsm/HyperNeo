import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { WorkTurn } from '../../storage/work-turns.ts';
import { defineOperation } from '../operations/registry.ts';
import type { RemoteDaemons } from './find-operation.ts';
import { workResultSchema, type Result } from './types.ts';
import { forwardWork, reject } from './work-operations.ts';

export const ReadWorkInputSchema = z.object({
  sessionId: z.string().min(1),
  daemon: z.string().min(1).optional(),
  around: z.string().min(1).optional(),
  before: z.number().int().min(0).max(10).default(2),
  after: z.number().int().min(0).max(10).default(2),
});

export const ReadWorkResultSchema = workResultSchema(
  z.object({
    sessionId: z.string(),
    turns: z.array(
      z.object({ messageId: z.string(), role: z.string(), at: z.number(), text: z.string() })
    ),
  })
);

type ReadInput = z.infer<typeof ReadWorkInputSchema>;
type ReadResult = Result<{ sessionId: string; turns: WorkTurn[] }>;

export interface ReadWorkDeps {
  readTurns(
    sessionId: string,
    around: string | undefined,
    before: number,
    after: number
  ): WorkTurn[] | null;
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
    reason: forwardWork(daemon, 'work.read', local, ReadWorkResultSchema, deps.remote),
  };
}

export function readLocalTurns(input: ReadInput, deps: ReadWorkDeps): ReadResult {
  const turns = deps.readTurns(input.sessionId, input.around, input.before, input.after);
  if (!turns) {
    return reject(
      'not_found',
      input.around
        ? `No message ${input.around} in session ${input.sessionId}.`
        : `No readable turns in session ${input.sessionId}.`
    );
  }
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
      'Read the user and agent turns of a session, by the handle on a work.find snippet: sessionId, around (its messageId) and daemon (the place daemon, if any). Returns before turns earlier than the message, the message itself, and after turns later, oldest first; each turn text is cut at 4000 characters. Without around, returns the latest turns. Use this to check what a snippet came from instead of reading the whole session.',
    inputSchema: ReadWorkInputSchema,
    resultSchema: ReadWorkResultSchema,
    policy: { safetyClass: 'read' },
    execute: (input) => runReadWork(input, deps),
  });
}
