const STEP = 20 * 60_000;

export type FollowThroughIncident = {
  since: number;
  nudges: number;
  at?: number;
  redispatched?: boolean;
};

export function mayRedispatch(running: number, movedThisSweep: number) {
  return running < 6 && movedThisSweep < 1;
}

export function continuesIncident(prior: FollowThroughIncident, since: number) {
  return since <= prior.since || (prior.at !== undefined && since - prior.at < STEP / 2);
}

export function planFollowThrough(
  incident: FollowThroughIncident,
  now: number,
  follow: { remind: boolean; redispatch: boolean }
) {
  const due = Math.min(3, Math.floor((now - incident.since) / STEP));
  if (due <= incident.nudges || due < 1) return null;
  if (due < 3) return follow.remind ? { kind: 'remind' as const, nudges: due } : null;
  return {
    kind:
      follow.redispatch && !incident.redispatched ? ('redispatch' as const) : ('stall' as const),
    nudges: 3,
  };
}
