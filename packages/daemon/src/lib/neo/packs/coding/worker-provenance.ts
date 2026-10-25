import { workerEngine } from '@hyperneo/shared/types/worker-identity';

export function withCodingWorkerProvenance(
  instruction: string,
  identity: { model: string | null; effort: string | null; harness: string }
): string {
  const model = identity.model ?? '<exact model id>';
  const effort = identity.effort ?? '<effort>';
  const harness = workerEngine(identity.harness);
  return [
    instruction,
    '',
    'PR provenance:',
    `Agent: ${model} (effort: ${effort}) via ${harness}`,
    identity.model && identity.effort
      ? 'Copy this line exactly: the daemon recorded this model and effort for this worker session.'
      : 'The daemon has not recorded every identity field yet. Keep supplied values; obtain missing fields from the session runtime before publishing. Never guess or publish placeholders; report unavailable metadata to Neo.',
    'Use the exact model id, including its variant, and thinking effort. A family name such as GPT-6 is insufficient.',
    'Repair only open PRs; never rewrite a merged PR body.',
  ].join('\n');
}
