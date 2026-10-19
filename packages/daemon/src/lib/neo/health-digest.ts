import { isNeoUnattendedCleanup, type NeoProjectCleanup } from './project-cleanup.ts';

export type NeoHealthFacts = {
  projects: number;
  projectsCreated: number;
  projectsMerged: number;
  holders: number;
  holdersOpened: number;
  refusals: { what: string; count: number }[];
  doorRefusals: { operation: string; reason: string; count: number }[];
  repeatedReplies: { trigger: string; count: number }[];
  liveAsks: { id: string; title: string; status: string; updatedAt: number }[];
  unreadRepos: { repo: string; error: string }[];
};

export type NeoHealthRun = {
  cleanupPlanned: readonly NeoProjectCleanup[];
  cleanupFailed: readonly { projectId: string; reason: string }[];
};

const counts = (entries: readonly { key: string; count: number }[]) =>
  entries.length ? entries.map((entry) => `${entry.key} ${entry.count}`).join(', ') : 'none';

export function neoHealthDigest(facts: NeoHealthFacts, run: NeoHealthRun, since: number): string {
  const failed = new Set(run.cleanupFailed.map((entry) => entry.projectId));
  const done = run.cleanupPlanned.filter(
    (step) => isNeoUnattendedCleanup(step) && !failed.has(step.projectId)
  );
  const left = run.cleanupPlanned.filter((step) => !isNeoUnattendedCleanup(step));
  const step = (entry: NeoProjectCleanup) =>
    `${entry.action} ${entry.title} (${entry.projectId})${'targetId' in entry ? ` into ${entry.targetId}` : ''}`;
  return [
    `Nightly health digest since ${new Date(since).toISOString()}. Facts only.`,
    `Projects: ${facts.projects} now, ${facts.projectsCreated} created, ${facts.projectsMerged} merged away.`,
    `Project holder sessions: ${facts.holders} live, ${facts.holdersOpened} opened.`,
    `Cleanup done tonight: ${done.length ? done.map(step).join('; ') : 'none'}.`,
    `Cleanup failed tonight: ${run.cleanupFailed.length ? run.cleanupFailed.map((entry) => `${entry.projectId}: ${entry.reason}`).join('; ') : 'none'}.`,
    `Merges asked of the human, not applied: ${left.length ? left.map(step).join('; ') : 'none'}.`,
    `Card refusals by what was refused: ${counts(facts.refusals.map(({ what, count }) => ({ key: what, count })))}.`,
    `Operation refusals at the agent door by operation and reason: ${counts(facts.doorRefusals.map(({ operation, reason, count }) => ({ key: `${operation} ${reason}`, count })))}.`,
    `Triggers that got more than one message: ${counts(facts.repeatedReplies.map(({ trigger, count }) => ({ key: trigger, count })))}.`,
    `Live asks: ${
      facts.liveAsks.length
        ? facts.liveAsks
            .map(
              (ask) =>
                `${ask.id} "${ask.title}" ${ask.status}, last changed ${new Date(ask.updatedAt).toISOString()}${ask.updatedAt < since ? ' (untouched since the last digest)' : ''}`
            )
            .join('; ')
        : 'none'
    }.`,
    `Watched GitHub repos whose last poll failed: ${
      facts.unreadRepos.length
        ? facts.unreadRepos.map((entry) => `${entry.repo}: ${entry.error}`).join('; ')
        : 'none'
    }.`,
  ].join('\n');
}
