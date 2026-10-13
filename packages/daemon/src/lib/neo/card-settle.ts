import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import {
  isNeoWorkClosedDone,
  NEO_WORK_CLOSED_DONE_PREFIX,
} from '@hyperneo/shared/types/neo-snapshot';
import type { NeoEvidenceRead } from './evidence.ts';

export const NEO_WORK_CLOSED_BY_DAEMON = `${NEO_WORK_CLOSED_DONE_PREFIX}the daemon: `;

export function planNeoCardDaemonSettle(
  work: Pick<NeoWork, 'status' | 'report'>,
  found: { read: NeoEvidenceRead | null }
): { report: string } | null {
  const evidence = found.read?.evidence ?? [];
  if (
    work.status !== 'reported' ||
    isNeoWorkClosedDone(work.report) ||
    !found.read?.read.ok ||
    !found.read.daemonRead ||
    !evidence.length ||
    evidence.some((item) => item.state !== 'done')
  )
    return null;
  const read = evidence.map((item) => `${item.key} ${item.summary}`).join('; ');
  return {
    report: [`${NEO_WORK_CLOSED_BY_DAEMON}${read}.`, work.report?.trim()]
      .filter(Boolean)
      .join('\n\n'),
  };
}

export function requireNeoCardDaemonUnsettled<T>(
  settle: { report: string } | null,
  value: T
): { value: T } | { reason: 'daemon_settled' } {
  return settle ? { reason: 'daemon_settled' } : { value };
}
