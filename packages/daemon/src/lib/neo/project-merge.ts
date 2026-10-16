import type { NeoProject } from '@hyperneo/shared/types/neo-context';
import { neoProjectPath } from '@hyperneo/shared/types/neo-project-tree';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';
import { readNeoAskAnswerChoice } from './ask-answer-evidence.ts';

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
  unavailable: readonly string[];
  retired: readonly string[];
}
export type NeoProjectMergeResult =
  | { ok: true; sourceId: string; targetId: string }
  | {
      ok: false;
      reason: 'superseded' | 'unsafe_tree' | 'project_busy' | 'identity_conflict' | 'needs_human';
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

export function requireNeoMergeIdle(plan: Plan, state: NeoProjectMergeState): Gate {
  return [plan.source.id, plan.target.id].some((id) => state.unavailable.includes(id))
    ? { reason: { ok: false, reason: 'project_busy' } }
    : { value: plan };
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

export function planNeoProjectMerges(
  state: NeoProjectMergeState,
  fresh: Readonly<Record<string, readonly string[]>>
): NeoProjectMergeInput[] {
  const key = (id: string) =>
    [...new Set([...(state.identities[id] ?? []), ...(fresh[id] ?? [])])].sort().join(' ');
  const live = state.projects
    .filter((project) => !state.retired.includes(project.id) && project.id !== 'inbox')
    .filter((project) => !project.epicUrl && key(project.id))
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const merged = new Set<string>();
  return live.flatMap((target) => {
    if (merged.has(target.id)) return [];
    merged.add(target.id);
    return live.flatMap((source) => {
      if (
        merged.has(source.id) ||
        (source.parentId ?? null) !== (target.parentId ?? null) ||
        key(source.id) !== key(target.id)
      )
        return [];
      merged.add(source.id);
      return [
        {
          sourceId: source.id,
          targetId: target.id,
          sourceRevision: source.revision,
          targetRevision: target.revision,
          sourceIdentities: fresh[source.id] ?? [],
          targetIdentities: fresh[target.id] ?? [],
        },
      ];
    });
  });
}

export function mergeNeoDuplicateProjects(
  plan: () => readonly NeoProjectMergeInput[],
  merge: (input: NeoProjectMergeInput) => NeoProjectMergeResult,
  log: (line: string) => void
): { sourceId: string; targetId: string }[] {
  const merged: { sourceId: string; targetId: string }[] = [];
  const refused = new Set<string>();
  for (;;) {
    const next = plan().find((input) => !refused.has(`${input.sourceId}\u0000${input.targetId}`));
    if (!next) return merged;
    const result = merge(next);
    if (result.ok) {
      merged.push({ sourceId: result.sourceId, targetId: result.targetId });
      continue;
    }
    refused.add(`${next.sourceId}\u0000${next.targetId}`);
    log(`neo reorganize: did not merge ${next.sourceId} into ${next.targetId}: ${result.reason}`);
  }
}

export const NEO_PROJECT_SAME = 'Same project';
export const NEO_PROJECT_SEPARATE = 'Keep separate';

export type NeoProjectQuestion = NeoProjectMergeInput & { key: string } & (
    | { repository: string }
    | { why: string }
  );

export function planNeoProjectQuestions(
  state: NeoProjectMergeState,
  fresh: Readonly<Record<string, readonly string[]>>,
  repositories: Readonly<Record<string, readonly string[]>>
): NeoProjectQuestion[] {
  const identities = (id: string) =>
    [...new Set([...(state.identities[id] ?? []), ...(fresh[id] ?? [])])].sort().join(' ');
  const live = state.projects
    .filter((project) => !state.retired.includes(project.id) && project.id !== 'inbox')
    .filter((project) => !project.epicUrl)
    .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
  const paired = new Set<string>();
  return live.flatMap((target, index) =>
    live.slice(index + 1).flatMap((source) => {
      if (paired.has(target.id) || paired.has(source.id)) return [];
      const repository = (repositories[source.id] ?? []).find((name) =>
        repositories[target.id]?.includes(name)
      );
      if (
        !repository ||
        state.unavailable.includes(source.id) ||
        state.unavailable.includes(target.id) ||
        (source.parentId ?? null) !== (target.parentId ?? null) ||
        (identities(source.id) && identities(target.id))
      )
        return [];
      paired.add(source.id);
      return [
        {
          key: `neo-project-merge:${[target.id, source.id].sort().join('\u0000')}`,
          repository,
          sourceId: source.id,
          targetId: target.id,
          sourceRevision: source.revision,
          targetRevision: target.revision,
          sourceIdentities: fresh[source.id] ?? [],
          targetIdentities: fresh[target.id] ?? [],
        },
      ];
    })
  );
}

export const NEO_PROJECT_QUESTION_ATTEMPTS = 3;

export function neoProjectQuestionKey(key: string, attempt: number): string {
  return attempt === 1 ? key : `${key}#${attempt}`;
}

export type NeoProjectDecision = { decision: 'same' | 'separate' | 'pending' } | { ask: number };

export function readNeoProjectDecision(
  asks: readonly (Pick<NeoAsk, 'doneItems' | 'status'> | null)[],
  key: string
): NeoProjectDecision {
  for (const [index, ask] of asks.slice(0, NEO_PROJECT_QUESTION_ATTEMPTS).entries()) {
    if (!ask) return { ask: index + 1 };
    const item = ask.doneItems?.find((entry) => entry.decides === key && !entry.removed);
    if (item?.state === 'met') {
      const choice = readNeoAskAnswerChoice(item.evidence);
      if (choice === NEO_PROJECT_SAME) return { decision: 'same' };
      if (choice === NEO_PROJECT_SEPARATE) return { decision: 'separate' };
    } else if (item && ask.status !== 'abandoned' && ask.status !== 'achieved') {
      return { decision: 'pending' };
    }
  }
  return asks.length < NEO_PROJECT_QUESTION_ATTEMPTS
    ? { ask: asks.length + 1 }
    : { decision: 'separate' };
}

export function settleNeoProjectQuestions(
  questions: () => readonly NeoProjectQuestion[],
  decision: (question: NeoProjectQuestion) => NeoProjectDecision,
  merge: (input: NeoProjectMergeInput) => NeoProjectMergeResult,
  ask: (question: NeoProjectQuestion, attempt: number) => boolean,
  log: (line: string) => void
): {
  merged: { sourceId: string; targetId: string }[];
  asked: { sourceId: string; targetId: string }[];
} {
  const merged: { sourceId: string; targetId: string }[] = [];
  const asked: { sourceId: string; targetId: string }[] = [];
  const handled = new Set<string>();
  for (;;) {
    const next = questions().find((question) => !handled.has(question.key));
    if (!next) return { merged, asked };
    handled.add(next.key);
    const decided = decision(next);
    const pair = { sourceId: next.sourceId, targetId: next.targetId };
    if ('ask' in decided) {
      if (ask(next, decided.ask)) asked.push(pair);
      continue;
    }
    if (decided.decision !== 'same') continue;
    const result = merge({ ...next, humanApproved: true });
    if (result.ok) merged.push(pair);
    else
      log(`neo reorganize: did not merge ${next.sourceId} into ${next.targetId}: ${result.reason}`);
  }
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
    .pipe(requireNeoMergeIdle, ['merge', 'state'], 'result:merge')
    .pipe(requireNeoMergeIdentity, ['merge', 'input', 'state'], 'result:merge')
    .pipe(write, 'merge', 'merge')
    .end('merge') as (input: NeoProjectMergeInput) => NeoProjectMergeResult;
}
