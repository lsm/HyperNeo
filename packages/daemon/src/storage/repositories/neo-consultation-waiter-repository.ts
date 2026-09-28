import type { NeoConsultation, NeoConsultationWaiter } from '@hyperneo/shared/types/neo-context';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../sqlite-compat.ts';
import { NeoConsultationRepository } from './neo-consultation-repository.ts';

const columns = `id, request_key AS requestKey, concern_id AS concernId,
  origin_session_id AS originSessionId, origin_message_id AS originMessageId,
  session_id AS sessionId, question, status, created_at AS createdAt`;

type Admission<T> = { value: T } | { reason: 'busy' | 'conflict' | null };

function requireQueuedWaiter(
  waiter: NeoConsultationWaiter | undefined
): Admission<NeoConsultationWaiter> {
  return waiter?.status === 'queued' ? { value: waiter } : { reason: null };
}

function requireMatchingConsultation(
  waiter: NeoConsultationWaiter | undefined,
  item: NeoConsultation | null
): Admission<NeoConsultation> {
  if (!item) return { reason: 'busy' };
  return waiter &&
    item?.status === 'pending' &&
    item.id === waiter.id &&
    item.requestKey === waiter.requestKey &&
    item.concernId === waiter.concernId &&
    item.sessionId === waiter.sessionId &&
    item.originSessionId === waiter.originSessionId &&
    item.originMessageId === waiter.originMessageId &&
    item.question === waiter.question
    ? { value: item }
    : { reason: 'conflict' };
}

function markWaiterAdmitted(db: Database, item: NeoConsultation): NeoConsultation {
  const changed = db
    .prepare(`UPDATE neo_consultation_waiters SET status = 'admitted'
    WHERE id = ? AND status = 'queued'`)
    .run(item.id);
  if (changed.changes !== 1) throw new Error('Consultation waiter changed during admission.');
  return item;
}

const admitNeoConsultationWaiter = (
  superpipe({})('neo-consultation-waiter-admission') as PipelineAPI
)
  .input(['db', 'waiter'])
  .pipe(requireQueuedWaiter, 'waiter', 'result:admission')
  .pipe(
    (db: Database, waiter: NeoConsultationWaiter) =>
      new NeoConsultationRepository(db, () => {}).reserve(waiter) ??
      new NeoConsultationRepository(db, () => {}).get(waiter.id),
    ['db', 'admission'],
    'consultation'
  )
  .pipe(requireMatchingConsultation, ['waiter', 'consultation'], 'result:admission')
  .pipe(markWaiterAdmitted, ['db', 'admission'], 'admission')
  .end('admission') as (
  db: Database,
  waiter: NeoConsultationWaiter | undefined
) => NeoConsultation | 'busy' | 'conflict' | null;

export class NeoConsultationWaiterRepository {
  constructor(
    private readonly db: Database,
    private readonly notify: () => void
  ) {}

  get(id: string): NeoConsultationWaiter | null {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_consultation_waiters WHERE id = ?`)
      .get(id) as NeoConsultationWaiter | null;
  }

  find(originSessionId: string, requestKey: string): NeoConsultationWaiter | null {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_consultation_waiters
      WHERE origin_session_id = ? AND request_key = ?`)
      .get(originSessionId, requestKey) as NeoConsultationWaiter | null;
  }

  queued(concernId?: string): NeoConsultationWaiter[] {
    return this.db
      .prepare(`SELECT ${columns} FROM neo_consultation_waiters WHERE status = 'queued'
      ${concernId ? 'AND concern_id = ?' : ''} ORDER BY created_at, rowid LIMIT 20`)
      .all(...(concernId ? [concernId] : [])) as NeoConsultationWaiter[];
  }

  queuedConcerns(): string[] {
    return (
      this.db
        .prepare(`SELECT concern_id AS concernId FROM neo_consultation_waiters
        WHERE status = 'queued' GROUP BY concern_id ORDER BY MIN(rowid)`)
        .all() as { concernId: string }[]
    ).map(({ concernId }) => concernId);
  }

  enqueue(
    input: Omit<NeoConsultationWaiter, 'status' | 'createdAt'>
  ): NeoConsultationWaiter | null {
    const result = this.db
      .prepare(`INSERT INTO neo_consultation_waiters
      (id, request_key, concern_id, origin_session_id, origin_message_id,
      session_id, question, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?) ON CONFLICT DO NOTHING`)
      .run(
        input.id,
        input.requestKey,
        input.concernId,
        input.originSessionId,
        input.originMessageId,
        input.sessionId,
        input.question,
        Date.now()
      );
    if (result.changes) this.notify();
    return this.find(input.originSessionId, input.requestKey);
  }

  admitNext(concernId: string): NeoConsultation | null {
    let changed = false;
    const admitted = this.db.transaction(() => {
      let waiter = this.queued(concernId)[0];
      while (waiter) {
        const result = admitNeoConsultationWaiter(this.db, waiter);
        if (result !== 'conflict') return result;
        const cancelled = this.db
          .prepare(`UPDATE neo_consultation_waiters SET status = 'cancelled'
          WHERE id = ? AND status = 'queued'`)
          .run(waiter.id);
        if (cancelled.changes !== 1)
          throw new Error('Consultation waiter changed during cancellation.');
        changed = true;
        waiter = this.queued(concernId)[0];
      }
      return null;
    })();
    if (changed || (admitted && admitted !== 'busy')) this.notify();
    return admitted === 'busy' ? null : admitted;
  }

  cancel(id: string): NeoConsultationWaiter | null {
    const result = this.db
      .prepare(`UPDATE neo_consultation_waiters SET status = 'cancelled'
      WHERE id = ? AND status = 'queued'`)
      .run(id);
    if (result.changes) this.notify();
    return this.get(id);
  }
}
