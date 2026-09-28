import type { DaemonInventoryLink } from '@hyperneo/shared/types/daemon-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';

const opaque = (max: number) =>
  z
    .string()
    .max(max)
    .refine((value) => !!value.trim());

export const NeoWorkResourceReferences = z
  .array(z.object({ kind: opaque(64), id: opaque(160) }))
  .max(16);

export function selectNeoWorkResourceRefs(
  input: unknown
): { value: DaemonInventoryLink[] } | { reason: null } {
  const parsed = NeoWorkResourceReferences.safeParse(input);
  return parsed.success ? { value: parsed.data } : { reason: null };
}

export function canonicalNeoWorkResourceRefs(refs: readonly DaemonInventoryLink[]) {
  const keyed = new Map(refs.map(({ kind, id }) => [JSON.stringify([kind, id]), { kind, id }]));
  return [...keyed.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, ref]) => ref);
}

const normalize = (superpipe({})('neo-work-resource-references') as PipelineAPI)
  .input('input')
  .pipe(selectNeoWorkResourceRefs, 'input', 'result:refs')
  .pipe(canonicalNeoWorkResourceRefs, 'refs', 'refs')
  .end('refs') as (input: unknown) => DaemonInventoryLink[] | null;

export function decodeNeoWorkResourceRefs(json: string): DaemonInventoryLink[] | null {
  try {
    return normalize(JSON.parse(json));
  } catch {
    return null;
  }
}
