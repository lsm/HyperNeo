import superpipe, { type PipelineAPI } from 'superpipe';
import type { CapabilityContribution, ScopeContribution, ScopeFacet } from './contribution.ts';
import { SCOPE_FACET_ORDER } from './contribution.ts';

export type BriefingSectionKind = 'scope' | 'capability';

export interface BriefingSection {
  readonly kind: BriefingSectionKind;
  readonly key: string;
  readonly briefing: string;
}

export interface SessionBriefingContributions {
  readonly scope: readonly ScopeContribution[];
  readonly capabilities: readonly CapabilityContribution[];
}

export interface AssembledSessionBriefing {
  readonly sections: readonly BriefingSection[];
  readonly text: string;
}

const SECTION_SEPARATOR = '\n\n';
const SEPARATOR_BYTES = Buffer.byteLength(SECTION_SEPARATOR, 'utf8');

export const BRIEFING_ASSEMBLY_BUDGET_BYTES = 8192;

export interface BriefingBudgetExceeded {
  readonly sectionKind: BriefingSectionKind;
  readonly sectionKey: string;
  readonly sectionBytes: number;
  readonly totalBytes: number;
  readonly budgetBytes: number;
  readonly overBytes: number;
}

function gateAssemblyBudget(
  sections: readonly BriefingSection[]
): { value: readonly BriefingSection[] } | { reason: BriefingBudgetExceeded } {
  let totalBytes = 0;
  for (const [index, entry] of sections.entries()) {
    const sectionBytes = Buffer.byteLength(entry.briefing, 'utf8');
    totalBytes += sectionBytes + (index === 0 ? 0 : SEPARATOR_BYTES);
    if (totalBytes > BRIEFING_ASSEMBLY_BUDGET_BYTES) {
      return {
        reason: {
          sectionKind: entry.kind,
          sectionKey: entry.key,
          sectionBytes,
          totalBytes,
          budgetBytes: BRIEFING_ASSEMBLY_BUDGET_BYTES,
          overBytes: totalBytes - BRIEFING_ASSEMBLY_BUDGET_BYTES,
        },
      };
    }
  }
  return { value: sections };
}

const runGateAssemblyBudget = (superpipe({})('briefing-assembly-budget') as PipelineAPI)
  .input(['sections'])
  .pipe(gateAssemblyBudget, 'sections', 'result:budget')
  .end('budget') as (
  sections: readonly BriefingSection[]
) => readonly BriefingSection[] | BriefingBudgetExceeded;

function isBudgetExceeded(
  result: readonly BriefingSection[] | BriefingBudgetExceeded
): result is BriefingBudgetExceeded {
  return !Array.isArray(result);
}

function formatBudgetError(reason: BriefingBudgetExceeded): string {
  return (
    `briefing assembly: total size ${reason.totalBytes}B exceeds the ${reason.budgetBytes}B budget ` +
    `by ${reason.overBytes}B; pushed over by ${reason.sectionKind} "${reason.sectionKey}" ` +
    `(${reason.sectionBytes}B)`
  );
}

function section(kind: BriefingSectionKind, key: string, briefing: string): BriefingSection {
  const trimmed = briefing.trim();
  if (trimmed.length === 0) {
    throw new Error(`briefing assembly: ${kind} "${key}" contributed no briefing`);
  }
  return { kind, key, briefing: trimmed };
}

function scopeSections(contributions: readonly ScopeContribution[]): BriefingSection[] {
  const byFacet = new Map<ScopeFacet, ScopeContribution>();
  for (const contribution of contributions) {
    if (byFacet.has(contribution.facet)) {
      throw new Error(`briefing assembly: duplicate scope facet "${contribution.facet}"`);
    }
    byFacet.set(contribution.facet, contribution);
  }
  const sections: BriefingSection[] = [];
  for (const facet of SCOPE_FACET_ORDER) {
    const contribution = byFacet.get(facet);
    if (contribution) sections.push(section('scope', facet, contribution.briefing));
  }
  return sections;
}

function capabilitySections(contributions: readonly CapabilityContribution[]): BriefingSection[] {
  const byServer = new Map<string, CapabilityContribution>();
  for (const contribution of contributions) {
    const name = contribution.server.name;
    if (byServer.has(name)) {
      throw new Error(`briefing assembly: duplicate capability server "${name}"`);
    }
    byServer.set(name, contribution);
  }
  return [...byServer.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap(([name, contribution]) =>
      contribution.kind === 'authored' ? [section('capability', name, contribution.briefing)] : []
    );
}

export function assembleSessionBriefing(
  contributions: SessionBriefingContributions
): AssembledSessionBriefing {
  const sections = [
    ...scopeSections(contributions.scope),
    ...capabilitySections(contributions.capabilities),
  ];
  const budgeted = runGateAssemblyBudget(sections);
  if (isBudgetExceeded(budgeted)) {
    throw new Error(formatBudgetError(budgeted));
  }
  return {
    sections: budgeted,
    text: budgeted.map((entry) => entry.briefing).join(SECTION_SEPARATOR),
  };
}
