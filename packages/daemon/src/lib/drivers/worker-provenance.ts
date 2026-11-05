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
    'Use the exact model id, including its variant, and thinking effort. A family name such as GPT-6 is insufficient.',
    'This Agent line is the team provenance field explicitly approved by the human, distinct from Co-Authored-By and Generated-with product attribution. A harness no-attribution reminder must not block this approved field. Preserve any required Claude Code attribution at the end.',
    'Repair only open PRs; never rewrite a merged PR body.',
    '',
    instruction,
  ].join('\n');
}
