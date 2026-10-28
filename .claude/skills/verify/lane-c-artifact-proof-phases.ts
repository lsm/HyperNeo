import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function createArtifactProofPhases(run: string) {
  const started = performance.now();
  const phases: { phase: string; elapsedMs: number }[] = [];
  return (phase: string) => {
    phases.push({ phase, elapsedMs: performance.now() - started });
    writeFileSync(join(run, 'evidence/artifact-proof-phases.json'), JSON.stringify(phases));
  };
}
