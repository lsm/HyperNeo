import superpipe, { type PipelineAPI } from 'superpipe';
import type { AgentMemoryEmbedder } from '../../storage/repositories/agent-memory-repository.ts';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { readPendingTurns, saveTurnVector } from '../../storage/turn-vectors.ts';

export const WORK_TURN_EMBED = 'work.turns.embed';
const TURN_BATCH = 32;
const TURN_EMBED_INTERVAL_MS = 30_000;

export function scheduleTurnEmbedding(queue: JobQueueRepository): void {
  queue.enqueueUniquePending({
    queue: WORK_TURN_EMBED,
    payload: { scope: 'turns' },
    matchPayload: { scope: 'turns' },
    activeStatuses: ['pending'],
    runAt: Date.now() + TURN_EMBED_INTERVAL_MS,
  });
}

export async function embedPendingTurns(
  db: BunDatabase,
  embedder: AgentMemoryEmbedder
): Promise<{ embedded: number }> {
  const pending = readPendingTurns(db, embedder.model, embedder.dimensions, TURN_BATCH);
  for (const turn of pending) {
    const vector = Float32Array.from(await embedder.embedPassage(turn.text));
    saveTurnVector(db, turn, embedder.model, vector, Date.now());
  }
  return { embedded: pending.length };
}

export const runTurnEmbedding = (superpipe({})('work-turn-embedding') as PipelineAPI)
  .input(['queue', 'db', 'embedder'])
  .pipe(scheduleTurnEmbedding, 'queue')
  .pipe(embedPendingTurns, ['db', 'embedder'], 'result')
  .endAsync('result') as (
  queue: JobQueueRepository,
  db: BunDatabase,
  embedder: AgentMemoryEmbedder
) => Promise<{ embedded: number }>;
