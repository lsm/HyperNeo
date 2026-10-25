import {
  previewReferenceCandidates,
  type PreviewReferenceCandidate,
} from '@hyperneo/shared/types/artifact-reference';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { OperationCaller } from '../operations/registry.ts';
import {
  authorizeArtifactCaller,
  resolveArtifactSource,
  type ArtifactContext,
  type ArtifactContextBinding,
} from './file-policy.ts';

type SourceKey = { kind: 'message' | 'publication' | 'todo'; id: string; revisionId?: string };
type Revision = { kind: 'worktree'; baseCommit?: string } | { kind: 'commit'; sha: string };
export interface ReferenceBinding extends ArtifactContextBinding {
  readonly repository: string | null;
  readonly revision: Revision;
}
export interface StoredReferenceSource {
  readonly key: SourceKey;
  readonly text: string | readonly string[];
  readonly bindings: readonly ReferenceBinding[];
}
interface Dependencies {
  daemonId: string;
  home: string;
  loadSource: (key: SourceKey) => Promise<StoredReferenceSource | null>;
}
interface Request {
  source: SourceKey;
  reference: string;
  context?: ArtifactContext;
}
type Refusal = { accepted: false; reason: string; choices?: ArtifactContext[] };
type Plan =
  | {
      accepted: true;
      kind: 'worktree';
      context: ArtifactContext;
      root: string;
      relativePath: string;
      revision: Revision;
    }
  | {
      accepted: true;
      kind: 'git-blob';
      context: ArtifactContext;
      repository: string;
      sha: string;
      path: string;
    }
  | {
      accepted: true;
      kind: 'github-pr';
      context: ArtifactContext;
      repository: string;
      number: number;
    };
type Found = { candidate: PreviewReferenceCandidate; bindings: readonly ReferenceBinding[] };
const refuse = (reason = 'unavailable') => ({ accepted: false as const, reason });
const sameContext = (a: ArtifactContext, b: ArtifactContext) => a.kind === b.kind && a.id === b.id;
const immutable = (sha: string) => /^[a-f0-9]{40}$/.test(sha);

async function stored(request: Request, deps: Dependencies) {
  const source = await deps.loadSource(request.source);
  if (
    !source ||
    source.key.kind !== request.source.kind ||
    source.key.id !== request.source.id ||
    source.key.revisionId !== request.source.revisionId
  )
    return { reason: refuse() };
  const candidate = (typeof source.text === 'string' ? [source.text] : source.text)
    .flatMap(previewReferenceCandidates)
    .find((item) => item.reference === request.reference);
  return candidate ? { value: { candidate, bindings: source.bindings } } : { reason: refuse() };
}

function choose(found: Found, request: Request, caller: OperationCaller, deps: Dependencies) {
  const authorized = found.bindings.filter(
    (binding) => 'value' in authorizeArtifactCaller(binding, caller)
  );
  const bindings = request.context
    ? authorized.filter((binding) => sameContext(binding.context, request.context!))
    : authorized;
  if (!bindings.length) return { reason: refuse() };
  if (bindings.length !== 1)
    return {
      reason: {
        ...refuse('ambiguous_context'),
        choices: authorized.map((binding) => binding.context),
      },
    };
  return bindings[0].daemonId === deps.daemonId
    ? { value: { candidate: found.candidate, binding: bindings[0] } }
    : { reason: refuse('owning_daemon_unavailable') };
}

function target(
  selected: { candidate: PreviewReferenceCandidate; binding: ReferenceBinding },
  deps: Dependencies
): Plan | Refusal {
  const { candidate, binding } = selected;
  const context = binding.context;
  const repository = binding.repository?.toLowerCase();
  if (candidate.kind !== 'local') {
    if (!repository || repository !== candidate.repository) return refuse();
    if (candidate.kind === 'github-pr')
      return {
        accepted: true,
        kind: candidate.kind,
        context,
        repository,
        number: candidate.number,
      };
    const checked = resolveArtifactSource(
      { ...binding, workspacePath: '/repository', approvedEvidenceRoots: [] },
      candidate.path,
      { ...deps, loadBinding: () => binding }
    );
    return 'reason' in checked
      ? checked.reason
      : {
          accepted: true,
          kind: candidate.kind,
          context,
          repository,
          sha: candidate.sha,
          path: checked.value.relativePath,
        };
  }
  if (candidate.path.startsWith('~') && !candidate.path.startsWith('~/')) return refuse();
  const path = candidate.path.startsWith('~/')
    ? `${deps.home}/${candidate.path.slice(2)}`
    : candidate.path;
  const commit = binding.revision.kind === 'commit' && !path.startsWith('/');
  if (commit && !repository) return refuse('ambiguous_context');
  if (binding.revision.kind === 'commit' && !immutable(binding.revision.sha)) return refuse();
  if (
    binding.revision.kind === 'worktree' &&
    binding.revision.baseCommit &&
    !immutable(binding.revision.baseCommit)
  )
    return refuse();
  const checked = resolveArtifactSource(
    commit ? { ...binding, workspacePath: '/repository', approvedEvidenceRoots: [] } : binding,
    path,
    { ...deps, loadBinding: () => binding }
  );
  if ('reason' in checked) return checked.reason;
  return commit && binding.revision.kind === 'commit'
    ? {
        accepted: true,
        kind: 'git-blob',
        context,
        repository: repository!,
        sha: binding.revision.sha,
        path: checked.value.relativePath,
      }
    : {
        accepted: true,
        kind: 'worktree',
        ...checked.value,
        revision: {
          kind: 'worktree',
          ...(binding.revision.kind === 'worktree' && binding.revision.baseCommit
            ? { baseCommit: binding.revision.baseCommit }
            : {}),
        },
      };
}

export const planStoredReference = (superpipe({})('artifact-stored-reference-plan') as PipelineAPI)
  .input(['request', 'caller', 'deps'])
  .pipe(stored, ['request', 'deps'], 'result:plan')
  .pipe(choose, ['plan', 'request', 'caller', 'deps'], 'result:plan')
  .pipe(target, ['plan', 'deps'], 'plan')
  .endAsync('plan') as (
  request: Request,
  caller: OperationCaller,
  deps: Dependencies
) => Promise<Plan | Refusal>;
