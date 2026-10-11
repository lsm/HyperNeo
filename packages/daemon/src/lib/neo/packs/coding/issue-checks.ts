import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { GITHUB_REF_PATH } from '../../../github/parse-pr-url.ts';
import {
  extractNeoAskRefs,
  extractNeoCardRefs,
  type NeoRef,
  type NeoRefState,
  type NeoRefStateReader,
} from './ask-prs.ts';

export const CODING_CHECK_ISSUE_FILED = 'coding.issue_filed';
export const CODING_CHECK_ISSUE_SUB_ISSUE = 'coding.issue_sub_issue';
export const CODING_CHECK_ISSUE_CLOSED = 'coding.issue_closed';
const ISSUE_CHECKS: readonly string[] = [
  CODING_CHECK_ISSUE_FILED,
  CODING_CHECK_ISSUE_SUB_ISSUE,
  CODING_CHECK_ISSUE_CLOSED,
];
const NEO_ISSUE_READ_MS = 2 * 60_000;
const lastRead = new Map<string, number>();

export type NeoIssueCheckPlan = {
  item: NeoAskItem;
  epic: NeoRef | null;
  refs: NeoRef[];
  fallback: boolean;
};
export type NeoAskTick = { id: string; evidence: string };

const refKey = (ref: Pick<NeoRef, 'owner' | 'repo' | 'number'>) =>
  `${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase();

function urlKey(url: string): string | null {
  const match = /github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/i.exec(url);
  return match ? refKey({ owner: match[1], repo: match[2], number: Number(match[3]) }) : null;
}

const REF_URL = new RegExp(`https://${GITHUB_REF_PATH.source}`, 'g');

function itemRefs(text: string, repo: Pick<NeoRef, 'owner' | 'repo'> | null): NeoRef[] {
  const urls = [...text.matchAll(REF_URL)].map((match) => ({
    at: match.index,
    ref: { owner: match[1], repo: match[2], number: Number(match[3]) },
  }));
  const rest = text.replace(REF_URL, (url) => ' '.repeat(url.length));
  const named = extractNeoCardRefs(rest, repo).map((ref) => ({
    at: rest.indexOf(`#${ref.number}`),
    ref,
  }));
  const ordered = [...urls, ...named].sort((a, b) => a.at - b.at).map((item) => item.ref);
  return [...new Map(ordered.map((ref) => [refKey(ref), ref])).values()];
}

export function isNeoIssueCheckItem(item: NeoAskItem): boolean {
  return !!item.check && ISSUE_CHECKS.includes(item.check) && !item.removed && item.state !== 'met';
}

export function planNeoIssueChecks(ask: NeoAsk, reports: readonly string[]): NeoIssueCheckPlan[] {
  const repos = new Map(
    extractNeoAskRefs(ask, []).map((ref) => [`${ref.owner}/${ref.repo}`.toLowerCase(), ref])
  );
  const repo = repos.size === 1 ? [...repos.values()][0] : null;
  const reported = itemRefs(reports.join('\n'), repo);
  return (ask.doneItems ?? []).filter(isNeoIssueCheckItem).map((item) => {
    const named = itemRefs(item.text, repo);
    const epic = item.check === CODING_CHECK_ISSUE_SUB_ISSUE ? (named.at(-1) ?? null) : null;
    const own = epic ? named.slice(0, -1) : named;
    const refs = own.length ? own : reported.filter((ref) => !epic || refKey(ref) !== refKey(epic));
    return { item, epic, refs, fallback: !own.length };
  });
}

export function judgeNeoIssueCheck(
  plan: NeoIssueCheckPlan,
  states: readonly NeoRefState[],
  since: number
): NeoAskTick | null {
  const keys = new Set(plan.refs.map(refKey));
  const issues = states.filter(
    (state) =>
      state.kind === 'issue' &&
      keys.has(urlKey(state.url) ?? '') &&
      (!plan.fallback || (state.createdAt ?? 0) >= since)
  );
  if (plan.fallback && issues.length !== 1) return null;
  const check = plan.item.check;
  const found =
    check === CODING_CHECK_ISSUE_CLOSED
      ? issues.find((state) => state.done)
      : check === CODING_CHECK_ISSUE_SUB_ISSUE
        ? issues.find(
            (state) => plan.epic && state.parent && urlKey(state.parent.url) === refKey(plan.epic)
          )
        : issues[0];
  if (!found) return null;
  const evidence =
    check === CODING_CHECK_ISSUE_CLOSED
      ? `Closed: ${found.url}`
      : check === CODING_CHECK_ISSUE_SUB_ISSUE
        ? `Sub-issue of ${found.parent?.url}: ${found.url}`
        : `Filed: ${found.url}`;
  return { id: plan.item.id, evidence };
}

export async function readNeoIssueTicks(
  ask: NeoAsk,
  works: readonly NeoWork[],
  readRefStates: NeoRefStateReader,
  now: number
): Promise<NeoAskTick[]> {
  const plans = planNeoIssueChecks(
    ask,
    works.flatMap((work) => work.report ?? [])
  ).filter((plan) => plan.refs.length);
  if (!plans.length || now - (lastRead.get(ask.id) ?? -Infinity) < NEO_ISSUE_READ_MS) return [];
  lastRead.set(ask.id, now);
  const refs = new Map(plans.flatMap((plan) => plan.refs).map((ref) => [refKey(ref), ref]));
  const states = await readRefStates([...refs.values()]);
  return plans.flatMap((plan) => judgeNeoIssueCheck(plan, states, ask.createdAt) ?? []);
}
