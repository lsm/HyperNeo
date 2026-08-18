import type { SpaceWorkflow, SpaceWorkflowSummary } from '../types/space.ts';

export function isWorkflowAutoClosingAtLevel(
  wf: SpaceWorkflow | SpaceWorkflowSummary,
  level: number
): boolean {
  const threshold = wf.completionAutonomyLevel ?? 5;
  return level >= threshold;
}
