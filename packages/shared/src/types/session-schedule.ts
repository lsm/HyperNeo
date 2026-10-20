export type SessionScheduleCadence =
  | { kind: 'every'; everyMs: number }
  | { kind: 'cron'; cron: string; timezone: string };

export type SessionScheduleStatus = 'active' | 'paused' | 'done';

export interface SessionSchedule {
  id: string;
  target: { adapter: string; id: string; daemon?: string };
  sourceKind: string;
  sourceId: string;
  note: string | null;
  cadence: SessionScheduleCadence;
  nudgeEvery: number;
  status: SessionScheduleStatus;
  nextRunAt: number | null;
  pendingJobId: string | null;
  dueCount: number;
  factsDigest: string | null;
  lastRunAt: number | null;
  lastOutcome: string | null;
  lastSkipReason: string | null;
  lastMessageId: string | null;
  createdBySession: string | null;
  createdAt: number;
  updatedAt: number;
}

export type SessionScheduleView = SessionSchedule & { sourceLabel: string | null };

export type SessionScheduleListResult =
  | { ok: false; reason: string }
  | { ok: true; schedules: SessionScheduleView[] };
