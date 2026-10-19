import { NEO_PACK_CODING_INSTRUCTIONS, NEO_PACK_CODING_WORKER_RULES } from '@hyperneo/prompts';
import { type CodingTodoPrRepository, createCodingTodoPack } from './todo-prs.ts';
import type { NeoPack, NeoPackBrief } from '../types.ts';
import { routeNeoCardPrEvent } from './card-pr-events.ts';
import { prepareCodingExecution } from './prepare-execution.ts';
import {
  type CodingLedgerRead,
  type CodingPrLedgerRepository,
  readCodingLedgerRepo,
  reconcileCodingPrLedger,
} from './pr-ledger.ts';
import { type CodingPrEventRepository, deliverCodingPrEvents } from './pr-events.ts';
import { type CodingPrSweepRepository, type CodingSweepDeps, sweepCodingPrs } from './pr-sweep.ts';
import { type NeoWorkPrReader } from './work-prs.ts';

export const CODING_PACK_BRIEF: NeoPackBrief = {
  id: 'coding',
  describe: 'Software work in git repositories: pull requests, CI, review and merging.',
  guidance: NEO_PACK_CODING_INSTRUCTIONS,
};

export function createCodingPack(deps: {
  readPrs: NeoWorkPrReader;
  todoPrs: CodingTodoPrRepository;
  prLedger: CodingPrLedgerRepository;
  prSweep: CodingPrSweepRepository;
  prEvents: CodingPrEventRepository;
  prSweepDeps: CodingSweepDeps;
  projectRepos: () => string[];
  readLedgerRepo?: CodingLedgerRead;
}): NeoPack {
  const ledgerSkips = new Map<string, number>();
  return {
    ...CODING_PACK_BRIEF,
    prepareExecution: prepareCodingExecution,
    todos: createCodingTodoPack(deps.todoPrs, deps.readPrs, (url) => deps.prLedger.stateOf(url)),
    observeSessions: (sessions, now) => deps.prLedger.observeSessions(sessions, now),
    sweep: async (now) => {
      const transitions = await reconcileCodingPrLedger(
        deps.prLedger,
        deps.projectRepos(),
        deps.readLedgerRepo ?? readCodingLedgerRepo,
        now,
        ledgerSkips
      );
      await deliverCodingPrEvents(deps.prEvents, transitions, deps.prSweepDeps);
      await sweepCodingPrs(deps.prSweep, deps.prSweepDeps, now);
    },
    snapshotRows: (repos, now, openTodoIds) =>
      deps.prLedger.snapshot(
        repos,
        now,
        openTodoIds.flatMap((todoId) =>
          deps.todoPrs.urls(todoId).map((url) => ({
            todoId,
            url,
            state: deps.todoPrs.latest(url)?.pr.state ?? null,
          }))
        )
      ),
    instructions: () => NEO_PACK_CODING_INSTRUCTIONS,
    workerRules: NEO_PACK_CODING_WORKER_RULES,
    routeExternalEvent: (event, subscriptions) =>
      routeNeoCardPrEvent(event, subscriptions, (url) => deps.todoPrs.latest(url)),
  };
}
