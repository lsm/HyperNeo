export function planNudge(incident: { since: number; nudges: number }, now: number) {
  const due = Math.min(3, Math.floor((now - incident.since) / (20 * 60_000)));
  return due <= incident.nudges || due < 1
    ? null
    : { kind: due === 3 ? ('escalate' as const) : ('remind' as const), nudges: due };
}

const STEP = 20 * 60_000;

export type TodoIncident = { since: number; nudges: number; at?: number; redispatched?: boolean };

export function continuesTodoIncident(prior: TodoIncident, since: number) {
  return since <= prior.since || (prior.at !== undefined && since - prior.at < STEP / 2);
}

export function planTodoNudge(
  incident: TodoIncident,
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
