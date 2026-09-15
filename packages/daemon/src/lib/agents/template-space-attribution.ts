import superpipe, { type PipelineAPI } from 'superpipe';
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

export interface TemplateRungClaim {
  spaceIds: string[];
  rung: TemplateAttributionRung;
}

export interface UnclaimedTemplate {
  evidence: TemplateOwnershipEvidence;
  spaceIds: readonly string[];
}

export interface TemplateAssignment extends TemplateRungClaim {
  key: string;
}

export interface TemplateAttributionPlan {
  assignments: TemplateAssignment[];
  deletions: string[];
}

export interface TemplateAttributionInputs extends TemplateOwnershipInputs {
  spaceIds: readonly string[];
}

type RungGate = { value: UnclaimedTemplate } | { reason: TemplateRungClaim };

function liveSpaces(candidates: readonly string[], spaceIds: readonly string[]): string[] {
  const known = new Set(spaceIds);
  return candidates.filter((spaceId) => known.has(spaceId));
}

export function claimBySynthesis(unclaimed: UnclaimedTemplate): RungGate {
  const spaces = liveSpaces(unclaimed.evidence.synthesizedFromSpaces, unclaimed.spaceIds);
  if (spaces.length === 0) return { value: unclaimed };
  return { reason: { spaceIds: spaces, rung: 'synthesized-from-agent' } };
}

export function claimByWorkflowSlot(unclaimed: UnclaimedTemplate): RungGate {
  const spaces = liveSpaces(unclaimed.evidence.workflowSlotSpaces, unclaimed.spaceIds);
  if (spaces.length === 0) return { value: unclaimed };
  return { reason: { spaceIds: spaces, rung: 'workflow-slot-reference' } };
}

export function claimBySoleSpace(unclaimed: UnclaimedTemplate): RungGate {
  if (unclaimed.spaceIds.length !== 1) return { value: unclaimed };
  return { reason: { spaceIds: [unclaimed.spaceIds[0]], rung: 'sole-space' } };
}

const runAttributeTemplate = (superpipe()('attributeTemplateToSpaces') as PipelineAPI)
  .input(['unclaimed'])
  .pipe(claimBySynthesis, 'unclaimed', 'result:unclaimed')
  .pipe(claimByWorkflowSlot, 'unclaimed', 'result:unclaimed')
  .pipe(claimBySoleSpace, 'unclaimed', 'result:unclaimed')
  .end('unclaimed') as (unclaimed: UnclaimedTemplate) => UnclaimedTemplate | TemplateRungClaim;

export function attributeTemplate(unclaimed: UnclaimedTemplate): TemplateRungClaim {
  const outcome = runAttributeTemplate(unclaimed);
  return 'rung' in outcome ? outcome : { spaceIds: [], rung: 'unattributed' };
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
  const evidence = collectTemplateOwnershipEvidence(inputs);
  const assignments: TemplateAssignment[] = [];
  const deletions: string[] = [];

  for (const [key, entry] of evidence) {
    const claim = attributeTemplate({ evidence: entry, spaceIds });
    if (claim.spaceIds.length === 0) {
      deletions.push(key);
      continue;
    }
    assignments.push({ key, spaceIds: claim.spaceIds, rung: claim.rung });
  }

  return { assignments, deletions };
}
