import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import { neoProjectPath } from '@hyperneo/shared/types/neo-project-tree';
import superpipe, { type PipelineAPI } from 'superpipe';

export interface NeoProjectMergeInput {
  sourceId: string;
  targetId: string;
  sourceRevision: number;
  targetRevision: number;
  sourceIdentities: readonly string[];
  targetIdentities: readonly string[];
  humanApproved?: boolean;
}
export interface NeoProjectMergeState {
  projects: readonly NeoProject[];
  identities: Readonly<Record<string, readonly string[]>>;
  repositories?: Readonly<Record<string, readonly string[]>>;
  retired: readonly string[];
}
export type NeoProjectMergeResult =
  | { ok: true; sourceId: string; targetId: string }
  | {
      ok: false;
      reason: 'superseded' | 'unsafe_tree' | 'identity_conflict' | 'needs_human';
    };
type Plan = { source: NeoProject; target: NeoProject };
type Gate = { value: Plan } | { reason: NeoProjectMergeResult };

export function requireNeoMergeCurrent(
  input: NeoProjectMergeInput,
  state: NeoProjectMergeState
): Gate {
  const source = state.projects.find((project) => project.id === input.sourceId);
  const target = state.projects.find((project) => project.id === input.targetId);
  return source &&
    target &&
    source.revision === input.sourceRevision &&
    target.revision === input.targetRevision &&
    !state.retired.includes(source.id) &&
    !state.retired.includes(target.id)
    ? { value: { source, target } }
    : { reason: { ok: false, reason: 'superseded' } };
}

export function requireNeoMergeTree(plan: Plan, state: NeoProjectMergeState): Gate {
  const { source, target } = plan;
  const sourcePath = neoProjectPath(state.projects, source.id);
  const targetPath = neoProjectPath(state.projects, target.id);
  return source.id !== target.id &&
    source.id !== 'inbox' &&
    target.id !== 'inbox' &&
    !source.epicUrl &&
    !target.epicUrl &&
    sourcePath.length > 0 &&
    targetPath.length > 0 &&
    !sourcePath.some((node) => node.id === target.id) &&
    !targetPath.some((node) => node.id === source.id) &&
    (source.parentId ?? null) === (target.parentId ?? null)
    ? { value: plan }
    : { reason: { ok: false, reason: 'unsafe_tree' } };
}

export function requireNeoMergeIdentity(
  plan: Plan,
  input: NeoProjectMergeInput,
  state: NeoProjectMergeState
): Gate {
  const source = [
    ...new Set([...input.sourceIdentities, ...(state.identities[plan.source.id] ?? [])]),
  ].sort();
  const target = [
    ...new Set([...input.targetIdentities, ...(state.identities[plan.target.id] ?? [])]),
  ].sort();
  if (
    [...source, ...target].some(
      (identity) =>
        !/^git:[a-f0-9]{40,64}(?::[a-f0-9]{40,64})*$/.test(identity) &&
        !/^repository:[^/\s]+\/\S+$/.test(identity)
    )
  )
    return { reason: { ok: false, reason: 'identity_conflict' } };
  const stored = (id: string) => state.repositories?.[id] ?? [];
  const [sourceRepos, targetRepos] = [stored(plan.source.id), stored(plan.target.id)];
  const gits = (ids: string[]) => ids.filter((id) => id.startsWith('git:'));
  if (sourceRepos.length && targetRepos.length) {
    if (!sourceRepos.some((repository) => targetRepos.includes(repository)))
      return { reason: { ok: false, reason: 'identity_conflict' } };
  } else {
    const [left, right] = [gits(source), gits(target)];
    if (left.length && right.length && JSON.stringify(left) !== JSON.stringify(right))
      return { reason: { ok: false, reason: 'identity_conflict' } };
  }
  return (source.length > 0 && target.length > 0) || input.humanApproved
    ? { value: plan }
    : { reason: { ok: false, reason: 'needs_human' } };
}

export async function readNeoProjectIdentities(
  folders: readonly { projectId: string; folder: string }[],
  read: (folder: string) => Promise<{ codeIdentity?: string }>
): Promise<Record<string, string[]>> {
  const fresh: Record<string, string[]> = {};
  for (const { projectId, folder } of folders) {
    const { codeIdentity } = await read(folder);
    if (codeIdentity) fresh[projectId] = [...new Set([...(fresh[projectId] ?? []), codeIdentity])];
  }
  return fresh;
}

export function createNeoProjectMergePipeline(
  read: () => NeoProjectMergeState,
  write: (plan: Plan) => NeoProjectMergeResult
) {
  return (superpipe({})('neo-project-merge') as PipelineAPI)
    .input(['input'])
    .pipe(read, 'input', 'state')
    .pipe(requireNeoMergeCurrent, ['input', 'state'], 'result:merge')
    .pipe(requireNeoMergeTree, ['merge', 'state'], 'result:merge')
    .pipe(requireNeoMergeIdentity, ['merge', 'input', 'state'], 'result:merge')
    .pipe(write, 'merge', 'merge')
    .end('merge') as (input: NeoProjectMergeInput) => NeoProjectMergeResult;
}
