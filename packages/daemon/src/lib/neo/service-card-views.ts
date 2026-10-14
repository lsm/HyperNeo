import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoCardView, NeoWorkPrReceipt } from '@hyperneo/shared/types/neo-snapshot';
import { projectNeoSnapshotAsks } from './ask-operations.ts';
import { projectNeoAskViews } from './ask-views.ts';
import { projectNeoCardViews } from './card-views.ts';
import type { NeoAskTriggerRead } from './notification-triggers.ts';
import { isNeoWorkPrWaiting } from './packs/coding/work-prs.ts';
import type { NeoService } from './service.ts';

function projectNeoServiceCards(
  service: NeoService,
  listed: readonly NeoAsk[],
  work: readonly NeoWork[],
  settledLimit: number
): { asks: NeoAsk[]; cards: NeoCardView[]; workPrs: NeoWorkPrReceipt[] } {
  const workIds = work.map((item) => item.id);
  const drivers = service.driverTargets.receipts(workIds).map((receipt) => {
    const since = service.uncheckedSince(receipt.workId);
    return {
      ...receipt,
      ...(since === null ? {} : { uncheckedSince: since }),
      ...(service.isRetryable(receipt.workId) ? { retryable: true as const } : {}),
    };
  });
  const asks = projectNeoSnapshotAsks(
    listed,
    settledLimit,
    Date.now(),
    new Set(workIds.filter((id) => service.isContinueStalled(id)))
  );
  const workPrs = service.workPrs
    .list(workIds)
    .map(({ workId, prs }) => ({ workId, prs, waiting: isNeoWorkPrWaiting(prs) }));
  const cards = projectNeoCardViews({
    work: [...work],
    drivers,
    prs: workPrs,
    goals: service.workGoals.list(workIds),
    continues: service.workContinues.list(workIds),
    supersessions: service.workSupersessions.list(workIds),
    refusals: service.workRefusals.list().filter((row) => workIds.includes(row.workId)),
    asks,
  });
  return { asks, cards, workPrs };
}

export function readNeoAskTriggerView(service: NeoService, ask: NeoAsk): NeoAskTriggerRead | null {
  const work = ask.workIds.flatMap((id) => service.repo.getWork(id) ?? []);
  const { asks, cards, workPrs } = projectNeoServiceCards(service, [ask], work, 1);
  const view = projectNeoAskViews(asks, cards, workPrs)[0];
  return view ? { view, cards } : null;
}
