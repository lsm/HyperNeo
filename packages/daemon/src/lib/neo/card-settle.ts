import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  NEO_WORK_CLOSED_DONE_PREFIX,
  type NeoAsk,
  type NeoAskItem,
} from '@hyperneo/shared/types/neo-snapshot';
import type { NeoEvidenceRead } from './evidence.ts';
import { neoDaemonTickPath } from './needs-you.ts';

const openItems = (ask: Pick<NeoAsk, 'doneItems'>) =>
  (ask.doneItems ?? []).filter((item) => !item.removed && item.state !== 'met');

const waitsOnDaemonOrHuman = (item: NeoAskItem) => {
  const path = neoDaemonTickPath(item);
  return (
    !!item.question || ((path === 'check' || path === 'watch') && item.check !== 'coding.deployed')
  );
};

export function planNeoDaemonCardSettle(
  work: Pick<NeoWork, 'report'>,
  read: NeoEvidenceRead | null,
  ask: Pick<NeoAsk, 'doneItems'> | null
): { report: string | null } {
  const evidence = read?.read.ok ? read.evidence : [];
  const open = ask ? openItems(ask) : [];
  const settled =
    evidence.length > 0 &&
    evidence.every((item) => item.state === 'done') &&
    open.length > 0 &&
    open.every(waitsOnDaemonOrHuman);
  if (!settled) return { report: null };
  const why = evidence.map((item) => `${item.key} ${item.summary}`).join('; ');
  return {
    report: `${NEO_WORK_CLOSED_DONE_PREFIX}the daemon: ${why}.${work.report ? `\n\n${work.report}` : ''}`,
  };
}

export function requireNeoCardTurn<T>(
  settled: { report: string | null },
  value: T
): { value: T } | { reason: 'daemon_settled' } {
  return settled.report ? { reason: 'daemon_settled' } : { value };
}
