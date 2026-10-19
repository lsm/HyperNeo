import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { isNeoAnswerItem } from './answer-outcome.ts';
import {
  type NeoAsk,
  type NeoAskApprovalSpent,
  type NeoAskItem,
} from '@hyperneo/shared/types/neo-snapshot';
import type { NeoDriverTargetCard } from '../../storage/repositories/neo-driver-session-rows.ts';
import type { buildNeoCheckRegistry } from './packs/check-registry.ts';

type NeoAdmissionBlocker = { workId: string; reason: string; itemIds: string[] };
export interface NeoAdmissionDeps {
  bootedAt: number;
  readWork(id: string): NeoWork | null;
  readAsk(id: string): NeoAsk | null;
  readApproval?(id: string): boolean | null;
  readCard(id: string): NeoDriverTargetCard | null;
  readBlockers(id: string): NeoAdmissionBlocker[];
  claim(id: string, admitted: () => boolean): boolean;
  handOff(work: NeoWork): Promise<void>;
  release(id: string): void;
  markUncertain(id: string): void;
}

export function neoOutcomeEligibility(registry: ReturnType<typeof buildNeoCheckRegistry>) {
  return (_ask: NeoAsk, item: NeoAskItem): boolean => {
    if (item.metBy === 'human') return true;
    if (item.metBy === 'daemon' && isNeoAnswerItem(item)) return true;
    if (item.metBy !== 'daemon' || !item.check || !registry.ok) return false;
    const check = registry.resolve(item.check);
    return check.ok && check.value.independent;
  };
}

export function neoAskApprovalRefusal(
  ask: Pick<NeoAsk, 'approvedAt' | 'approvedRevision' | 'revision'> | null,
  _spent: NeoAskApprovalSpent | null | undefined
): string | null {
  if (!ask || ask.approvedAt == null) return 'not_approved';
  if ((ask.approvedRevision ?? null) !== (ask.revision ?? 0)) return 'approval_stale';
  return null;
}

export function isNeoAdmissionApproved(ask: NeoAsk | null, _now: number): boolean {
  return neoAskApprovalRefusal(ask, null) === null;
}
