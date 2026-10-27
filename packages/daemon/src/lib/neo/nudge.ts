export function planNudge(incident: { since: number; nudges: number }, now: number) {
  const due = Math.min(3, Math.floor((now - incident.since) / (20 * 60_000)));
  return due <= incident.nudges || due < 1
    ? null
    : { kind: due === 3 ? ('escalate' as const) : ('remind' as const), nudges: due };
}
