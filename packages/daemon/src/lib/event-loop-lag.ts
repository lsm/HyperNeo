import { takeSlowestQuery } from '../storage/sqlite-query-observability.ts';

export const EVENT_LOOP_LAG_TICK_MS = 250;
export const EVENT_LOOP_LAG_WARN_MS = 1_000;

type SlowestQuery = { durationMs: number; sql: string } | null;

export function describeEventLoopLag(
  lagMs: number,
  slowest: SlowestQuery,
  warnMs = EVENT_LOOP_LAG_WARN_MS
): string | null {
  if (lagMs < warnMs) return null;
  const sql = slowest
    ? `; slowest SQL ${Math.round(slowest.durationMs)}ms: ${slowest.sql.slice(0, 300)}`
    : '';
  return `[Daemon] Event loop blocked for ${Math.round(lagMs)}ms${sql}`;
}

export function startEventLoopLagLog(
  warn: (line: string) => void,
  deps: { now?: () => number; takeSlowest?: () => SlowestQuery; tickMs?: number } = {}
): () => void {
  const now = deps.now ?? (() => performance.now());
  const takeSlowest = deps.takeSlowest ?? takeSlowestQuery;
  const tickMs = deps.tickMs ?? EVENT_LOOP_LAG_TICK_MS;
  takeSlowest();
  let last = now();
  const timer = setInterval(() => {
    const at = now();
    const line = describeEventLoopLag(at - last - tickMs, takeSlowest());
    last = at;
    if (line) warn(line);
  }, tickMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
