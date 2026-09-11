import type { SpaceWorkflow } from '@hyperneo/shared';
import superpipe, { type Dependencies, type PipelineAPI } from 'superpipe';
import type { AgentTemplateResolver } from './run-template-snapshot.ts';
import { buildRunTemplateSnapshots } from './run-template-snapshot.ts';

export interface SnapshotlessPinnedRun {
  id: string;
  workflowId: string;
  payload: string;
  versionHash: string;
}

export type RunSnapshotMigrationSkipKind = 'unusable_definition';

export interface RunSnapshotMigrationSkip {
  kind: RunSnapshotMigrationSkipKind;
  message: string;
}

export type RunSnapshotSource = 'pinned' | 'live';

export interface RunSnapshotMigrationPlan {
  runId: string;
  workflowId: string;
  spaceId: string;
  versionHash: string;
  payload: string;
  source: RunSnapshotSource;
}

export interface PlanRunSnapshotMigrationDeps extends Dependencies {
  verifyVersion(payload: string, versionHash: string): boolean;
  loadWorkflow(workflowId: string): SpaceWorkflow | null;
  resolveTemplateFor: (spaceId: string) => AgentTemplateResolver;
  computeVersion(workflow: SpaceWorkflow): { versionHash: string; payload: string };
}

type Gate<T> = { value: T } | { reason: RunSnapshotMigrationSkip };

interface SourcedRun {
  run: SnapshotlessPinnedRun;
  definition: SpaceWorkflow;
  source: RunSnapshotSource;
}

interface SnapshottedRun extends SourcedRun {
  withSnapshots: SpaceWorkflow;
}

export function isRunSnapshotMigrationSkip(
  outcome: RunSnapshotMigrationPlan | RunSnapshotMigrationSkip
): outcome is RunSnapshotMigrationSkip {
  return 'kind' in outcome;
}

function parseWorkflow(payload: string): SpaceWorkflow | null {
  try {
    const parsed = JSON.parse(payload) as SpaceWorkflow;
    return parsed && Array.isArray(parsed.nodes) ? parsed : null;
  } catch {
    return null;
  }
}

export function gateSource(
  run: SnapshotlessPinnedRun,
  verifyVersion: PlanRunSnapshotMigrationDeps['verifyVersion'],
  loadWorkflow: PlanRunSnapshotMigrationDeps['loadWorkflow']
): Gate<SourcedRun> {
  const pinned = verifyVersion(run.payload, run.versionHash) ? parseWorkflow(run.payload) : null;
  if (pinned) return { value: { run, definition: pinned, source: 'pinned' } };

  const live = loadWorkflow(run.workflowId);
  if (live) return { value: { run, definition: live, source: 'live' } };

  return {
    reason: {
      kind: 'unusable_definition',
      message:
        `run ${run.id} has an unverifiable pinned payload (version ${run.versionHash}) ` +
        `and workflow ${run.workflowId} no longer exists; leaving it unmigrated`,
    },
  };
}

export function gateSnapshots(
  admitted: SourcedRun,
  resolveTemplateFor: PlanRunSnapshotMigrationDeps['resolveTemplateFor']
): Gate<SnapshottedRun> {
  const snapshots = buildRunTemplateSnapshots(
    admitted.definition,
    resolveTemplateFor(admitted.definition.spaceId)
  );
  return {
    value: { ...admitted, withSnapshots: { ...admitted.definition, templateSnapshots: snapshots } },
  };
}

export function buildPlan(
  admitted: SnapshottedRun,
  computeVersion: PlanRunSnapshotMigrationDeps['computeVersion']
): Gate<RunSnapshotMigrationPlan> {
  const { versionHash, payload } = computeVersion(admitted.withSnapshots);
  return {
    value: {
      runId: admitted.run.id,
      workflowId: admitted.definition.id,
      spaceId: admitted.definition.spaceId,
      versionHash,
      payload,
      source: admitted.source,
    },
  };
}

export function buildPlanRunSnapshotMigration(
  deps: PlanRunSnapshotMigrationDeps
): (run: SnapshotlessPinnedRun) => RunSnapshotMigrationPlan | RunSnapshotMigrationSkip {
  return (superpipe(deps)('planRunSnapshotMigration') as PipelineAPI)
    .input(['run'])
    .pipe(gateSource, ['run', 'verifyVersion', 'loadWorkflow'], 'result:admitted')
    .pipe(gateSnapshots, ['admitted', 'resolveTemplateFor'], 'result:admitted')
    .pipe(buildPlan, ['admitted', 'computeVersion'], 'result:admitted')
    .end('admitted') as (
    run: SnapshotlessPinnedRun
  ) => RunSnapshotMigrationPlan | RunSnapshotMigrationSkip;
}
