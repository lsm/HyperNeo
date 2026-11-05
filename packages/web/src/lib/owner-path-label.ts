import { previewReferenceCandidates } from '@hyperneo/shared/types/artifact-reference';
import superpipe, { type PipelineAPI } from 'superpipe';

export function ownerPathLabel(path: string, home?: string | null) {
  if (!home) return path;
  const root = home === '/' ? home : home.replace(/\/+$/, '');
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path === root ? '~' : path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

export const ownerPathLabels = (superpipe({})('owner-home-reference-labels') as PipelineAPI)
  .input(['text', 'home'])
  .pipe(
    (text: string, home?: string | null) => (home ? previewReferenceCandidates(text) : []),
    ['text', 'home'],
    'references'
  )
  .pipe(
    (references: ReturnType<typeof previewReferenceCandidates>, home?: string | null) =>
      new Map(
        references.flatMap((ref) => {
          if (ref.kind !== 'local') return [];
          const label = ownerPathLabel(ref.path, home);
          return label === ref.path ? [] : [[ref.reference, { path: ref.path, label }] as const];
        })
      ),
    ['references', 'home'],
    'labels'
  )
  .end('labels') as (
  text: string,
  home?: string | null
) => Map<string, { path: string; label: string }>;
