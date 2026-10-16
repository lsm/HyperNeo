import { isNeoContentlessCleanup, type NeoProjectCleanup } from './project-cleanup.ts';

export type NeoHealthFacts = {
  projects: number;
  projectsCreated: number;
  projectsMerged: number;
  holders: number;
  holdersOpened: number;
  routing: { signal: string; count: number }[];
  refusals: { what: string; count: number }[];
  liveAsks: { id: string; title: string; status: string; updatedAt: number }[];
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
    (step) => isNeoContentlessCleanup(step) && !failed.has(step.projectId)
  );
  const left = run.cleanupPlanned.filter((step) => !isNeoContentlessCleanup(step));
  const step = (entry: NeoProjectCleanup) =>
    `${entry.action} ${entry.title} (${entry.projectId})${'targetId' in entry ? ` into ${entry.targetId}` : ''}`;
  return [
    `Nightly health digest since ${new Date(since).toISOString()}. Facts only.`,
    `Projects: ${facts.projects} now, ${facts.projectsCreated} created, ${facts.projectsMerged} merged away.`,
    `Project holder sessions: ${facts.holders} live, ${facts.holdersOpened} opened.`,
    `Cleanup done tonight: ${done.length ? done.map(step).join('; ') : 'none'}.`,
    `Cleanup failed tonight: ${run.cleanupFailed.length ? run.cleanupFailed.map((entry) => `${entry.projectId}: ${entry.reason}`).join('; ') : 'none'}.`,
    `Cleanup that touches content, not applied: ${left.length ? left.map(step).join('; ') : 'none'}.`,
    `Routing by signal: ${counts(facts.routing.map(({ signal, count }) => ({ key: signal, count })))}.`,
    `Card refusals by what was refused: ${counts(facts.refusals.map(({ what, count }) => ({ key: what, count })))}.`,
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
  ].join('\n');
}
