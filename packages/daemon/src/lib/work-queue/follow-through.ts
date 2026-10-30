const STEP = 20 * 60_000;

export type FollowThroughIncident = {
  stallReminder?: {
    since: number;
    delivered: { id: string; at: number }[];
    pending?: string;
    sessionId?: string;
  };
  checkOnlyReminder?: FollowThroughIncident['stallReminder'];
  blockerReport?: { id: string; dispatchId: string; at: number; triagedAt?: number };
  since: number;
  nudges: number;
  at?: number;
  redispatched?: boolean;
  live?: string;
};

export function mayRedispatch(running: number, lastMovedAt: number, now: number, limit: number) {
  return running < limit && now - lastMovedAt >= 60_000;
}

function continuesIncident(prior: FollowThroughIncident, since: number) {
  return since <= prior.since || (prior.at !== undefined && since - prior.at < STEP / 2);
}

function planFollowThrough(
  incident: FollowThroughIncident,
  now: number,
  follow: { remind: boolean; redispatch: boolean; move: boolean }
) {
  const due = Math.min(3, Math.floor((now - incident.since) / STEP));
  if (due <= incident.nudges || due < 1) return null;
  if (due < 3) return follow.remind ? { kind: 'remind' as const, nudges: due } : null;
  if (!follow.redispatch || incident.redispatched) return { kind: 'stall' as const, nudges: 3 };
  return follow.move ? { kind: 'redispatch' as const, nudges: 3 } : null;
}

export function advanceFollowThrough(
  prior: FollowThroughIncident | null,
  worker: { since: number; live: string; idle: boolean },
  now: number,
  follow: { remind: boolean; redispatch: boolean; move: boolean }
) {
  const incident =
    prior && continuesIncident(prior, worker.since)
      ? { ...prior, nudges: Math.min(prior.nudges, 2) }
      : { since: worker.since, nudges: 0, ...(prior?.redispatched ? { redispatched: true } : {}) };
  const plan = worker.idle ? planFollowThrough(incident, now, follow) : null;
  const next: FollowThroughIncident =
    plan?.kind === 'redispatch'
      ? { since: now, nudges: 0, redispatched: true }
      : {
          ...incident,
          live: worker.live,
          nudges: plan?.nudges ?? incident.nudges,
          ...(plan ? { at: now } : {}),
        };
  return { incident, plan, next };
}
