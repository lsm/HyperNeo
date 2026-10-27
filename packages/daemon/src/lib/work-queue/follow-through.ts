const STEP = 20 * 60_000;

export type FollowThroughIncident = {
  since: number;
  nudges: number;
  at?: number;
  redispatched?: boolean;
  live?: string;
};

export function mayRedispatch(running: number, lastMovedAt: number, now: number) {
  return running < 6 && now - lastMovedAt >= 60_000;
}

export function continuesIncident(prior: FollowThroughIncident, since: number) {
  return since <= prior.since || (prior.at !== undefined && since - prior.at < STEP / 2);
}

export function planFollowThrough(
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
