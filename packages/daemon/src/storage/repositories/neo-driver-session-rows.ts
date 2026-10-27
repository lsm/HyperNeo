import type { NeoWorkDriverReceipt } from '@hyperneo/shared/types/neo-snapshot';
import { WorkDeliverySchema, type WorkRef, type WorkStatus } from '../../lib/drivers/types.ts';
import {
  NeoDriverTargetSchema,
  type DriverSent,
  type NeoDriverTarget,
} from '../../lib/neo/driver-work.ts';
import type { Database } from '../sqlite-compat.ts';

function storedInputEvidence(
  raw: string | null,
  ref: string | null
): Pick<DriverSent, 'receipt' | 'delivery'> {
  if (!raw || !ref) return {};
  try {
    const stored = JSON.parse(raw) as {
      ref?: unknown;
      receipt?: unknown;
      delivery?: unknown;
    } | null;
    if (stored?.ref !== ref) return {};
    const receipt = WorkDeliverySchema.shape.receipt.safeParse(stored?.receipt);
    const delivery = WorkDeliverySchema.safeParse(stored?.delivery);
    return {
      ...(receipt.success && receipt.data ? { receipt: receipt.data } : {}),
      ...(delivery.success ? { delivery: delivery.data } : {}),
    };
  } catch {
    return {};
  }
}

export type NeoDriverTargetCard = {
  model: string | null;
  effort: string | null;
  target: NeoDriverTarget | null;
  ref: WorkRef | null;
  followAnchor: number | null;
  liveStatus: WorkStatus | null;
  startedAt: number | null;
  retries: number;
  startInterrupted: boolean;
  needsYouSince: number | null;
  claimedAt: number | null;
};

export class NeoDriverSessionRows {
  constructor(
    protected readonly db: Database,
    private readonly table: 'neo_todo_sessions',
    private readonly key: 'todo_id'
  ) {}

  get(id: string): NeoDriverTarget | null {
    const row = this.db.prepare(`SELECT target FROM ${this.table} WHERE ${this.key} = ?`).get(id) as
      | { target: string }
      | null
      | undefined;
    if (!row) return null;
    const target = NeoDriverTargetSchema.safeParse(JSON.parse(row.target));
    return target.success ? target.data : null;
  }

  readCard(id: string): NeoDriverTargetCard | null {
    const row = this.db
      .prepare(
        `SELECT target, ref, actual_model AS model, actual_effort AS effort,
                follow_anchor AS followAnchor, live_status AS liveStatus,
                started_at AS startedAt, retries, start_interrupted AS startInterrupted,
                needs_you_since AS needsYouSince, claimed_at AS claimedAt
           FROM ${this.table} WHERE ${this.key} = ?`
      )
      .get(id) as
      | {
          target: string;
          model: string | null;
          effort: string | null;
          ref: string | null;
          followAnchor: number | null;
          liveStatus: WorkStatus | null;
          startedAt: number | null;
          retries: number;
          startInterrupted: number;
          needsYouSince: number | null;
          claimedAt: number | null;
        }
      | null
      | undefined;
    if (!row) return null;
    const target = NeoDriverTargetSchema.safeParse(JSON.parse(row.target));
    return {
      model: row.model,
      effort: row.effort,
      target: target.success ? target.data : null,
      ref: row.ref ? (JSON.parse(row.ref) as WorkRef) : null,
      followAnchor: row.followAnchor,
      liveStatus: row.liveStatus,
      startedAt: row.startedAt,
      retries: row.retries,
      startInterrupted: !!row.startInterrupted,
      needsYouSince: row.needsYouSince,
      claimedAt: row.claimedAt,
    };
  }

  readRef(id: string): WorkRef | null {
    const row = this.db
      .prepare(`SELECT ref FROM ${this.table} WHERE ${this.key} = ? AND ref IS NOT NULL`)
      .get(id) as { ref: string } | null | undefined;
    return row ? (JSON.parse(row.ref) as WorkRef) : null;
  }

  readFollowAnchor(id: string): number | null {
    const row = this.db
      .prepare(`SELECT follow_anchor AS at FROM ${this.table} WHERE ${this.key} = ?`)
      .get(id) as { at: number | null } | null | undefined;
    return row?.at ?? null;
  }

  recordFollowAnchor(id: string, at: number): void {
    this.db.prepare(`UPDATE ${this.table} SET follow_anchor = ? WHERE ${this.key} = ?`).run(at, id);
  }

  readLiveStatus(id: string): WorkStatus | null {
    const row = this.db
      .prepare(`SELECT live_status AS status FROM ${this.table} WHERE ${this.key} = ?`)
      .get(id) as { status: WorkStatus | null } | null | undefined;
    return row?.status ?? null;
  }

  readStartedAt(id: string): number | null {
    const row = this.db
      .prepare(`SELECT started_at AS startedAt FROM ${this.table} WHERE ${this.key} = ?`)
      .get(id) as { startedAt: number | null } | null | undefined;
    return row?.startedAt ?? null;
  }

  readSent(id: string): DriverSent | null {
    const row = this.db
      .prepare(
        `SELECT input_before AS inputBefore, sent_opening AS opening, sent_receipt AS receipt, ref
           FROM ${this.table} WHERE ${this.key} = ?`
      )
      .get(id) as
      | {
          inputBefore: number | null;
          opening: string | null;
          receipt: string | null;
          ref: string | null;
        }
      | null
      | undefined;
    const evidence = row ? storedInputEvidence(row.receipt, row.ref) : {};
    return row && row.inputBefore !== null && row.opening
      ? { inputBefore: row.inputBefore, opening: row.opening, ...evidence }
      : null;
  }

  readRetries(id: string): number {
    const row = this.db
      .prepare(`SELECT retries FROM ${this.table} WHERE ${this.key} = ?`)
      .get(id) as { retries: number } | null | undefined;
    return row?.retries ?? 0;
  }

  readStartInterrupted(id: string): boolean {
    const row = this.db
      .prepare(`SELECT start_interrupted AS interrupted FROM ${this.table} WHERE ${this.key} = ?`)
      .get(id) as { interrupted: number } | null | undefined;
    return !!row?.interrupted;
  }

  readCardCheck(id: string): { checkedAt: number; unchecked: boolean } | null {
    const row = this.db
      .prepare(`SELECT checked_at AS checkedAt, unchecked FROM ${this.table} WHERE ${this.key} = ?`)
      .get(id) as { checkedAt: number | null; unchecked: number } | null | undefined;
    return row?.checkedAt == null ? null : { checkedAt: row.checkedAt, unchecked: !!row.unchecked };
  }

  recordCardCheck(id: string, check: { checkedAt: number; unchecked: boolean }): void {
    this.db
      .prepare(`UPDATE ${this.table} SET checked_at = ?, unchecked = ? WHERE ${this.key} = ?`)
      .run(check.checkedAt, check.unchecked ? 1 : 0, id);
  }

  recordStartInterrupted(id: string): void {
    this.db.prepare(`UPDATE ${this.table} SET start_interrupted = 1 WHERE ${this.key} = ?`).run(id);
  }

  recordRetry(id: string): number {
    this.db.prepare(`UPDATE ${this.table} SET retries = retries + 1 WHERE ${this.key} = ?`).run(id);
    return this.readRetries(id);
  }

  readNeedsYouSince(id: string): number | null {
    const row = this.db
      .prepare(`SELECT needs_you_since AS since FROM ${this.table} WHERE ${this.key} = ?`)
      .get(id) as { since: number | null } | null | undefined;
    return row?.since ?? null;
  }

  recordStartedAt(id: string, startedAt: number | null): void {
    this.db
      .prepare(`UPDATE ${this.table} SET started_at = ? WHERE ${this.key} = ?`)
      .run(startedAt, id);
  }

  recordSent(id: string, sent: DriverSent | null): void {
    this.db
      .prepare(
        `UPDATE ${this.table} SET input_before = ?1, sent_opening = ?2,
          sent_receipt = CASE WHEN ?3 IS NULL AND ?4 IS NULL THEN NULL
            ELSE json_object('ref', ref, 'receipt', json(?3), 'delivery', json(?4)) END
          WHERE ${this.key} = ?5`
      )
      .run(
        sent?.inputBefore ?? null,
        sent?.opening ?? null,
        sent?.receipt ? JSON.stringify(sent.receipt) : null,
        sent?.delivery ? JSON.stringify(sent.delivery) : null,
        id
      );
  }

  recordNeedsYouSince(id: string, since: number | null): void {
    this.db
      .prepare(`UPDATE ${this.table} SET needs_you_since = ? WHERE ${this.key} = ?`)
      .run(since, id);
  }

  recordRef(
    id: string,
    ref: WorkRef,
    startedAt?: number,
    link?: string,
    observed: Pick<NeoWorkDriverReceipt, 'model' | 'effort'> = {},
    target?: unknown
  ): void {
    this.db
      .prepare(
        `UPDATE ${this.table}
          SET ref = ?1, started_at = ?2, link = ?3, actual_model = ?4, actual_effort = ?5,
            sent_receipt = CASE WHEN ref IS ?1 THEN sent_receipt ELSE NULL END,
            target = COALESCE(?7, target)
          WHERE ${this.key} = ?6`
      )
      .run(
        JSON.stringify(ref),
        startedAt ?? null,
        link ?? null,
        observed.model ?? null,
        observed.effort ?? null,
        id,
        target ? JSON.stringify(target) : null
      );
  }

  recordLive(
    id: string,
    status: WorkStatus,
    link: string | undefined,
    remoteLink?: string
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE ${this.table}
            SET live_status = ?1, link = COALESCE(?2, link), remote_link = ?4
          WHERE ${this.key} = ?3 AND (live_status IS NOT ?1 OR (?2 IS NOT NULL AND link IS NOT ?2)
            OR remote_link IS NOT ?4)`
      )
      .run(status, link ?? null, id, remoteLink ?? null);
    return result.changes > 0;
  }
}
