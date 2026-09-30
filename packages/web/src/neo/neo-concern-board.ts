import type {
  NeoConcern,
  NeoConsultation,
  NeoConsultationWaiter,
  NeoWork,
} from '@hyperneo/shared/types/neo-context';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import type {
  DaemonInventoryEntry,
  DaemonInventoryLink,
  DaemonSnapshot,
} from '@hyperneo/shared/types/daemon-snapshot';
import superpipe, { type PipelineAPI } from 'superpipe';

type Selection = {
  snapshot: NeoSnapshot;
  concern: NeoConcern | null;
  work: NeoWork[];
  consultations: NeoConsultation[];
  consultationWaiters: NeoConsultationWaiter[];
};
type Receipt =
  | (NeoWork & { kind: 'work' })
  | (Omit<NeoConsultation, 'status'> & {
      kind: 'consultation';
      status: NeoConsultation['status'] | 'queued';
    });
type Relation = { from: DaemonInventoryLink; to: DaemonInventoryLink };
type Participant = { ref: DaemonInventoryLink; metadata: DaemonInventoryEntry | null };
export type NeoConcernBoard = {
  concern: NeoConcern | null;
  receipts: Receipt[];
  participants: Participant[];
  relations: Relation[];
  inventoryCapturedAt: number | null;
  truncatedKinds: string[];
};
const refKey = ({ kind, id }: DaemonInventoryLink) => JSON.stringify([kind, id]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const validRef = (ref: DaemonInventoryLink) =>
  !!ref &&
  typeof ref.kind === 'string' &&
  !!ref.kind.trim() &&
  typeof ref.id === 'string' &&
  !!ref.id.trim();

export function selectNeoConcernBoard(
  snapshot: NeoSnapshot | null,
  concernId: string | null
): { value: Selection } | { reason: null } {
  if (!snapshot) return { reason: null };
  const concern = snapshot.concerns.find((item) => item.id === concernId) ?? null;
  if (concernId !== null && !concern) return { reason: null };
  return {
    value: {
      snapshot,
      concern,
      work: snapshot.work.filter((item) => concernId === null || item.concernId === concernId),
      consultations: (snapshot.consultations ?? []).filter(
        (item) => concernId === null || item.concernId === concernId
      ),
      consultationWaiters: (snapshot.consultationWaiters ?? []).filter(
        (item) =>
          item.status === 'queued' &&
          (concernId === null || item.concernId === concernId) &&
          !snapshot.consultations?.some((active) => active.id === item.id)
      ),
    },
  };
}

export function neoBoardReceipts(selection: Selection): Receipt[] {
  return [
    ...selection.work.map((item) => ({ ...item, kind: 'work' as const })),
    ...selection.consultations.map((item) => ({ ...item, kind: 'consultation' as const })),
    ...selection.consultationWaiters.map((item) => ({
      ...item,
      kind: 'consultation' as const,
      status: 'queued' as const,
      answer: null,
    })),
  ].sort((a, b) => b.createdAt - a.createdAt || compare(refKey(a), refKey(b)));
}

export function neoBoardReferences(selection: Selection, receipts: readonly Receipt[]) {
  const workIds = new Set(receipts.filter((item) => item.kind === 'work').map((item) => item.id));
  const reported = new Map<string, DaemonInventoryLink[] | null>();
  for (const row of selection.snapshot.workResources ?? []) {
    if (!row || !workIds.has(row.workId)) continue;
    reported.set(
      row.workId,
      reported.has(row.workId) || !Array.isArray(row.refs) || row.refs.length > 16
        ? null
        : row.refs.filter(validRef).map((ref) => ({ ...ref }))
    );
  }
  const targets = receipts
    .flatMap((item) => (item.sessionId ? [{ kind: 'session', id: item.sessionId }] : []))
    .filter(validRef);
  const seeds = [
    ...(selection.snapshot.sessionId
      ? [{ kind: 'session', id: selection.snapshot.sessionId }]
      : []),
    ...receipts.map((item) => ({ kind: 'session', id: item.originSessionId })),
    ...targets,
    ...[...reported.values()].flatMap((refs) => refs ?? []),
  ].filter(validRef);
  return { seeds, targets };
}

export function observedNeoBoardResources(
  { seeds, targets }: ReturnType<typeof neoBoardReferences>,
  inventory: DaemonSnapshot | null
): { participants: Participant[]; relations: Relation[] } {
  const known = new Map<string, { ref: DaemonInventoryLink; metadata: DaemonInventoryEntry }>();
  for (const page of inventory?.resources ?? [])
    for (const metadata of page.entries) {
      const ref = { kind: page.kind, id: metadata.id };
      if (validRef(ref)) known.set(refKey(ref), { ref, metadata });
    }
  const selected = new Map(seeds.map((ref) => [refKey(ref), { ...ref }]));
  const anchorKeys = new Set(targets.map(refKey));
  for (const [key, item] of known)
    if (item.metadata.links.some((ref) => validRef(ref) && anchorKeys.has(refKey(ref))))
      selected.set(key, item.ref);
  const pending = [...selected.keys()];
  const relations = new Map<string, Relation>();
  for (const key of pending) {
    const item = known.get(key);
    if (!item) continue;
    for (const linked of item.metadata.links.filter(validRef)) {
      const to = { kind: linked.kind, id: linked.id };
      const linkedKey = refKey(to);
      if (!selected.has(linkedKey)) {
        selected.set(linkedKey, to);
        pending.push(linkedKey);
      }
      relations.set(JSON.stringify([key, linkedKey]), { from: { ...item.ref }, to });
    }
  }
  return {
    participants: [...selected]
      .sort(([a], [b]) => compare(a, b))
      .map(([key, ref]) => ({
        ref,
        metadata: known.get(key)?.metadata ?? null,
      })),
    relations: [...relations].sort(([a], [b]) => compare(a, b)).map(([, relation]) => relation),
  };
}

export function presentNeoConcernBoard(
  selection: Selection,
  receipts: Receipt[],
  resources: ReturnType<typeof observedNeoBoardResources>,
  inventory: DaemonSnapshot | null
): NeoConcernBoard {
  return {
    concern: selection.concern,
    receipts,
    ...resources,
    inventoryCapturedAt: inventory?.capturedAt ?? null,
    truncatedKinds: [
      ...new Set(
        (inventory?.resources ?? []).filter((page) => page.truncated).map((page) => page.kind)
      ),
    ].sort(compare),
  };
}

export const projectNeoConcernBoard = (superpipe({})('neo-concern-board') as PipelineAPI)
  .input(['snapshot', 'concernId', 'inventory'])
  .pipe(selectNeoConcernBoard, ['snapshot', 'concernId'], 'result:board')
  .pipe(neoBoardReceipts, 'board', 'receipts')
  .pipe(neoBoardReferences, ['board', 'receipts'], 'references')
  .pipe(observedNeoBoardResources, ['references', 'inventory'], 'resources')
  .pipe(presentNeoConcernBoard, ['board', 'receipts', 'resources', 'inventory'], 'board')
  .end('board') as (
  snapshot: NeoSnapshot | null,
  concernId: string | null,
  inventory: DaemonSnapshot | null
) => NeoConcernBoard | null;

export { projectNeoScenes } from './neo-scenes.ts';
