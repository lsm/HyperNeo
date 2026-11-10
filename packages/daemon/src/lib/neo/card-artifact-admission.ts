import { ARTIFACT_DEFAULT_LIMITS, type ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import type { z } from 'zod';
import type { OperationCaller } from '../operations/registry.ts';
import type { ArtifactRefReader } from '../artifacts/read-operations.ts';
import { unregisteredArtifact } from '../artifacts/file-contracts.ts';
import { getDataDir } from '../data-dir.ts';
import { PublicHandoffReference, readPublicHandoff } from '../handoffs/outbox.ts';

type Handoff = z.infer<typeof PublicHandoffReference>;
type CardArtifact = ArtifactRef | Handoff;
type Fact =
  | { kind: 'handoff'; verified: boolean }
  | { kind: 'saved'; reference: ArtifactRef | null };

export async function readCardArtifactFacts(
  refs: readonly CardArtifact[],
  caller: OperationCaller,
  saved: ArtifactRefReader
): Promise<Fact[]> {
  return Promise.all(
    refs.map(async (ref): Promise<Fact> => {
      if (!('type' in ref)) return { kind: 'saved', reference: saved(ref.artifactId, caller) };
      const extension = ref.name.split('.').at(-1)?.toLowerCase() ?? '';
      if (
        !['md', 'markdown', 'html', 'htm'].includes(extension) ||
        ref.byteLength > ARTIFACT_DEFAULT_LIMITS.documentPreviewBytes
      )
        return { kind: 'handoff', verified: false };
      try {
        return {
          kind: 'handoff',
          verified: (await readPublicHandoff(getDataDir(), ref, 0, 0)).kind === 'read',
        };
      } catch {
        return { kind: 'handoff', verified: false };
      }
    })
  );
}

export function unverifiedCardArtifact(refs: readonly CardArtifact[], facts: readonly Fact[]) {
  return (
    refs.find((ref, index) => {
      const fact = facts[index];
      if ('type' in ref) return fact?.kind !== 'handoff' || !fact.verified;
      return fact?.kind !== 'saved' || !!unregisteredArtifact([ref], [fact.reference]);
    }) ?? null
  );
}
