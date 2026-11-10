import {
  WORKER_PROVENANCE_EXACT_ID,
  WORKER_PROVENANCE_TEAM_FIELD,
  WORKER_PROVENANCE_OPEN_PRS,
} from '@hyperneo/prompts';
import { workerEngine } from '@hyperneo/shared/types/worker-identity';

export function withWorkerProvenance(
  instruction: string,
  identity: { model: string | null; effort: string | null; harness: string }
): string {
  const model = identity.model ?? 'unknown';
  const effort = identity.effort ?? 'unknown';
  const harness = workerEngine(identity.harness);
  return [
    `Worker delivery: ${crypto.randomUUID()}`,
    'Worker provenance (last observed runtime identity):',
    `Agent: ${model} (effort: ${effort}) via ${harness}`,
    identity.model && identity.effort
      ? 'Copy this line exactly: the daemon recorded this model and effort for this worker session.'
      : 'The daemon has not recorded every identity field yet. Keep supplied values; obtain missing fields from the session runtime before publishing. Never guess or publish placeholders; report unavailable metadata to Neo.',
    WORKER_PROVENANCE_EXACT_ID,
    WORKER_PROVENANCE_TEAM_FIELD,
    WORKER_PROVENANCE_OPEN_PRS,
    '',
    instruction,
  ].join('\n');
}
