import type { ProviderUsageResult } from '@hyperneo/shared/provider';
import type { NeoLine, NeoLineRanking, NeoLineScope } from '../../pack-contract.ts';

type LineFilter = { kinds?: string[]; repos?: string[]; projects?: string[] };
export type RouteLine = NeoLine & { stopAtPercent?: number };
export type Route = { kind: string; repos?: string[]; lines: RouteLine[] };
export type LineRule = { line: NeoLine; only?: LineFilter; never?: LineFilter };
export type LineHold = { provider: string; model: string; reason?: string; retryAt: number };
export type UsageReading = { result: ProviderUsageResult; readAt: number };
export type Availability = 'ready' | 'not configured' | 'not signed in';

export const USAGE_STALE_MS = 15 * 60 * 1000;

export interface RankInput {
  kind: string;
  candidates: readonly NeoLine[];
  scope: NeoLineScope;
  prefs: { routes: readonly Route[]; rules: readonly LineRule[] };
  holds: readonly LineHold[];
  usage: Readonly<Record<string, UsageReading | undefined>>;
  availability: Readonly<Record<string, Availability | undefined>>;
  now: number;
}

const names = (route: NeoLine, line: NeoLine) =>
  route.provider === line.provider &&
  route.model === line.model &&
  (route.harness === undefined || route.harness === line.harness) &&
  (route.effort === undefined || route.effort === line.effort);

const matches = (filter: LineFilter, kind: string, scope: NeoLineScope) =>
  (!filter.kinds || filter.kinds.includes(kind)) &&
  (!filter.repos || (scope.repo !== undefined && filter.repos.includes(scope.repo))) &&
  (!filter.projects ||
    (scope.projectId !== undefined && filter.projects.includes(scope.projectId)));

function allowed(line: NeoLine, input: RankInput): boolean {
  const rules = input.prefs.rules.filter((rule) => names(rule.line, line));
  if (rules.some((rule) => rule.never && matches(rule.never, input.kind, input.scope)))
    return false;
  const only = rules.flatMap((rule) => (rule.only ? [rule.only] : []));
  return only.length === 0 || only.some((filter) => matches(filter, input.kind, input.scope));
}

function usedPercent(reading: UsageReading | undefined, now: number): number | null {
  if (!reading?.result.supported || now - reading.readAt > USAGE_STALE_MS) return null;
  const windows = reading.result.windows.filter((window) => window.limit > 0);
  return windows.length
    ? Math.max(...windows.map((window) => (window.used / window.limit) * 100))
    : null;
}

function skipReason(line: NeoLine, stopAt: number | undefined, input: RankInput): string | null {
  const availability = input.availability[line.provider] ?? 'not configured';
  if (availability !== 'ready') return availability;
  if (!allowed(line, input)) return 'excluded by a rule';
  const hold = input.holds.find(
    (held) =>
      held.provider === line.provider && held.model === line.model && held.retryAt > input.now
  );
  if (hold)
    return `held${hold.reason ? ` (${hold.reason})` : ''} until ${new Date(hold.retryAt).toISOString()}`;
  const percent = usedPercent(input.usage[line.provider], input.now);
  if (percent !== null && percent >= 100) return 'usage exhausted';
  if (percent !== null && stopAt !== undefined && percent > stopAt)
    return `over stopAtPercent ${stopAt}`;
  return null;
}

export function rankLines(input: RankInput): NeoLineRanking {
  const routes = input.prefs.routes.filter((route) => route.kind === input.kind);
  const route =
    routes.find(
      (entry) => entry.repos && input.scope.repo && entry.repos.includes(input.scope.repo)
    ) ?? routes.find((entry) => !entry.repos);
  const position = (line: NeoLine) => {
    const index = route?.lines.findIndex((entry) => names(entry, line)) ?? -1;
    return index === -1 ? Number.POSITIVE_INFINITY : index;
  };
  const ordered = input.candidates
    .map((line, index) => ({ line, index }))
    .sort((a, b) => position(a.line) - position(b.line) || a.index - b.index);
  const ranked: NeoLineRanking['ranked'][number][] = [];
  const skipped: NeoLineRanking['skipped'][number][] = [];
  for (const { line } of ordered) {
    const stopAt = route?.lines.find((entry) => names(entry, line))?.stopAtPercent;
    const reason = skipReason(line, stopAt, input);
    if (reason) skipped.push({ line, reason });
    else
      ranked.push(
        usedPercent(input.usage[line.provider], input.now) === null
          ? { line, reason: 'usage unknown' }
          : { line }
      );
  }
  return { ranked, skipped, exhausted: input.candidates.length > 0 && ranked.length === 0 };
}
