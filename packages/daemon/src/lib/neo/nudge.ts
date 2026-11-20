export const NUDGE_STEPS = 3;

export function planNudge(incident: { since: number; nudges: number }, now: number) {
  const due = Math.min(NUDGE_STEPS, Math.floor((now - incident.since) / (20 * 60_000)));
  return due <= incident.nudges || due < 1
    ? null
    : { kind: due === NUDGE_STEPS ? ('escalate' as const) : ('remind' as const), nudges: due };
}
