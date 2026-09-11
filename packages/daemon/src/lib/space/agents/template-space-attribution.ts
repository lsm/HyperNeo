import {
  collectTemplateOwnershipEvidence,
  type TemplateOwnershipEvidence,
  type TemplateOwnershipInputs,
} from './template-ownership-evidence.ts';

export type TemplateAttributionRung =
  | 'synthesized-from-agent'
  | 'workflow-slot-reference'
  | 'sole-space'
  | 'unattributed';

export interface TemplateAssignment {
  key: string;
  spaceIds: string[];
  rung: TemplateAttributionRung;
}

export interface TemplateAttributionPlan {
  assignments: TemplateAssignment[];
  deletions: string[];
}

export interface TemplateAttributionInputs extends TemplateOwnershipInputs {
  spaceIds: readonly string[];
}

function pickRung(
  evidence: TemplateOwnershipEvidence,
  spaceIds: readonly string[]
): { spaceIds: string[]; rung: TemplateAttributionRung } {
  if (evidence.synthesizedFromSpaces.length > 0) {
    return { spaceIds: [...evidence.synthesizedFromSpaces], rung: 'synthesized-from-agent' };
  }
  if (evidence.workflowSlotSpaces.length > 0) {
    return { spaceIds: [...evidence.workflowSlotSpaces], rung: 'workflow-slot-reference' };
  }
  if (spaceIds.length === 1) {
    return { spaceIds: [spaceIds[0]], rung: 'sole-space' };
  }
  return { spaceIds: [], rung: 'unattributed' };
}

export function planTemplateSpaceAssignments(
  inputs: TemplateAttributionInputs
): TemplateAttributionPlan {
  const spaceIds = [
    ...new Set(
      inputs.spaceIds
        .map((spaceId) => (typeof spaceId === 'string' ? spaceId.trim() : ''))
        .filter((spaceId) => spaceId !== '')
    ),
  ];
  const known = new Set(spaceIds);
  const evidence = collectTemplateOwnershipEvidence(inputs);
  const assignments: TemplateAssignment[] = [];
  const deletions: string[] = [];

  for (const [key, entry] of evidence) {
    const picked = pickRung(entry, spaceIds);
    const live = picked.spaceIds.filter((spaceId) => known.has(spaceId));
    if (live.length === 0) {
      deletions.push(key);
      continue;
    }
    assignments.push({ key, spaceIds: live, rung: picked.rung });
  }

  return { assignments, deletions };
}
