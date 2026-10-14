import type { NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoRefStateReader } from './ask-prs.ts';
import { requireNeoGithubRef } from './github-read.ts';
import { CODING_CHECK_PR_MERGED } from './watch-checks.ts';

export type NeoPrerequisiteBaseReaders = {
  readRefStates: NeoRefStateReader;
  readMergeCommit: (url: string) => Promise<string | null>;
  cardBase: (workId: string) => string | null;
};

export type NeoPrerequisiteBase =
  | { ok: true; value: Record<string, string[]> }
  | { ok: false; reason: string; retry: boolean };

function neoPrerequisiteMergeWatches(items: readonly NeoAskItem[]) {
  return items
    .filter(
      (item) => item.check === CODING_CHECK_PR_MERGED && item.state === 'met' && !item.removed
    )
    .map((item) =>
      (item.watch ?? []).flatMap((url) => {
        const ref = requireNeoGithubRef(url);
        return 'value' in ref ? [{ item, ref: ref.value }] : [];
      })
    );
}

export async function readCodingPrerequisiteBase(
  items: readonly NeoAskItem[],
  readers: NeoPrerequisiteBaseReaders
): Promise<NeoPrerequisiteBase> {
  const perItem = neoPrerequisiteMergeWatches(items);
  if (perItem.some((watches) => !watches.length))
    return { ok: false, reason: 'prerequisite_ref_missing', retry: false };
  const watches = perItem.flat();
  if (!watches.length) return { ok: true, value: {} };
  const prs = new Set<string>();
  for (const { item, ref } of watches) {
    const [state] = await readers.readRefStates([ref]);
    if (!state) return { ok: false, reason: 'prerequisite_ref_unreadable', retry: true };
    const required =
      (item.deliveredBy ? readers.cardBase(item.deliveredBy) : null) ?? state.defaultBase;
    const landed =
      state.kind === 'pr'
        ? state.state === 'MERGED' && state.base === required
          ? [state.url]
          : []
        : (state.merges ?? []).filter((merge) => merge.base === required).map((merge) => merge.url);
    if (!landed.length)
      return { ok: false, reason: `prerequisite_not_merged: ${state.url}`, retry: false };
    for (const url of landed) prs.add(url);
  }
  const commits: string[] = [];
  for (const url of prs) {
    const commit = await readers.readMergeCommit(url);
    if (!commit) return { ok: false, reason: `prerequisite_merge_unknown: ${url}`, retry: true };
    commits.push(commit);
  }
  return { ok: true, value: { prerequisiteCommits: commits } };
}
