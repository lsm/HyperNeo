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
    .map(([name, contribution]) => section('capability', name, contribution.briefing));
}

export function assembleSessionBriefing(
  contributions: SessionBriefingContributions
): AssembledSessionBriefing {
  const sections = [
    ...scopeSections(contributions.scope),
    ...capabilitySections(contributions.capabilities),
  ];
  return {
    sections,
    text: sections.map((entry) => entry.briefing).join(SECTION_SEPARATOR),
  };
}
