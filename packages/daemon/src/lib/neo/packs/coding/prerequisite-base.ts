import type { NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoRef, NeoRefStateReader } from './ask-prs.ts';
import { requireNeoGithubRef } from './github-read.ts';
import { CODING_CHECK_PR_MERGED } from './watch-checks.ts';

export type NeoPrerequisiteBaseReaders = {
  readRefStates: NeoRefStateReader;
  readMergeCommit: (url: string) => Promise<string | null>;
};

export type NeoPrerequisiteBase =
  | { ok: true; value: Record<string, string[]> }
  | { ok: false; reason: string };

function neoPrerequisiteMergeRefs(items: readonly NeoAskItem[]): NeoRef[] {
  return items
    .filter(
      (item) => item.check === CODING_CHECK_PR_MERGED && item.state === 'met' && !item.removed
    )
    .flatMap((item) => item.watch ?? [])
    .flatMap((url) => {
      const ref = requireNeoGithubRef(url);
      return 'value' in ref ? [ref.value] : [];
    });
}

export async function readCodingPrerequisiteBase(
  items: readonly NeoAskItem[],
  readers: NeoPrerequisiteBaseReaders
): Promise<NeoPrerequisiteBase> {
  const refs = neoPrerequisiteMergeRefs(items);
  if (!refs.length) return { ok: true, value: {} };
  const states = await readers.readRefStates(refs);
  if (states.length !== refs.length) return { ok: false, reason: 'prerequisite_ref_unreadable' };
  const prs = states.flatMap((state) =>
    state.kind === 'pr'
      ? state.state === 'MERGED'
        ? [state.url]
        : []
      : (state.merges ?? []).map((merge) => merge.url)
  );
  if (!prs.length) return { ok: false, reason: 'prerequisite_not_merged' };
  const commits: string[] = [];
  for (const url of [...new Set(prs)]) {
    const commit = await readers.readMergeCommit(url);
    if (!commit) return { ok: false, reason: `prerequisite_merge_unknown: ${url}` };
    commits.push(commit);
  }
  return { ok: true, value: { prerequisiteCommits: commits } };
}
