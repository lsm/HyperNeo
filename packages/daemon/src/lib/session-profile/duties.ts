import superpipe, { type PipelineAPI } from 'superpipe';

export type Duty = 'escalation' | 'goal_owner_fallback' | 'review_authority';

export interface DutyDeclarer {
  readonly agentId: string;
  readonly handle: string | null;
  readonly status: string;
  readonly duties: readonly Duty[];
}

export interface DutyQuery {
  readonly duty: Duty;
  readonly declarers: readonly DutyDeclarer[];
}

export interface DutyHolders {
  readonly duty: Duty;
  readonly holders: readonly DutyDeclarer[];
}

export type DutyFallbackReason = 'no_declarer' | 'no_active_holder';

export type DutySource =
  | {
      readonly kind: 'ownershipPattern';
      readonly target: string;
      readonly relationship: string;
    }
  | { readonly kind: 'declaredDuty'; readonly duty: string };

const DUTY_BY_SOURCE_KEY: Record<string, Duty> = {
  'ownershipPattern:goal:manager': 'goal_owner_fallback',
  'ownershipPattern:goal:owner': 'goal_owner_fallback',
  'declaredDuty:escalation': 'escalation',
  'declaredDuty:review_authority': 'review_authority',
};

function sourceKey(source: DutySource): string {
  return source.kind === 'ownershipPattern'
    ? `ownershipPattern:${source.target}:${source.relationship}`
    : `declaredDuty:${source.duty}`;
}

export function deriveDuties(sources: readonly DutySource[] | undefined): Duty[] {
  const found = new Set<Duty>();
  for (const source of sources ?? []) {
    const duty = DUTY_BY_SOURCE_KEY[sourceKey(source)];
    if (duty) found.add(duty);
  }
  return [...found].sort();
}

export function ownershipPatternSources(
  patterns: readonly { target: string; relationship: string }[] | undefined
): DutySource[] {
  return (patterns ?? []).map((pattern) => ({
    kind: 'ownershipPattern',
    target: pattern.target,
    relationship: pattern.relationship,
  }));
}

export function declaredDutySources(declared: readonly string[] | undefined): DutySource[] {
  return (declared ?? []).map((duty) => ({ kind: 'declaredDuty', duty }));
}

export function gateDeclarersPresent(
  query: DutyQuery
): { value: DutyQuery } | { reason: DutyFallbackReason } {
  if (query.declarers.length === 0) return { reason: 'no_declarer' };
  return { value: query };
}

export function gateActiveHolder(
  query: DutyQuery
): { value: DutyHolders } | { reason: DutyFallbackReason } {
  const holders = query.declarers
    .filter((declarer) => declarer.status === 'active' && declarer.duties.includes(query.duty))
    .sort(
      (a, b) => (a.handle ?? '').localeCompare(b.handle ?? '') || a.agentId.localeCompare(b.agentId)
    );
  if (holders.length === 0) return { reason: 'no_active_holder' };
  return { value: { duty: query.duty, holders } };
}

export const resolveDutyHolders = (superpipe({})('resolve-duty-holders') as PipelineAPI)
  .input(['query'])
  .pipe(gateDeclarersPresent, 'query', 'result:holders')
  .pipe(gateActiveHolder, 'holders', 'result:holders')
  .end('holders') as (query: DutyQuery) => DutyHolders | DutyFallbackReason;

export function isDutyFallback(
  outcome: DutyHolders | DutyFallbackReason
): outcome is DutyFallbackReason {
  return typeof outcome === 'string';
}

export function resolveDutyHolderId(query: DutyQuery): string | null {
  const outcome = resolveDutyHolders(query);
  if (isDutyFallback(outcome)) return null;
  return outcome.holders[0]?.agentId ?? null;
}
