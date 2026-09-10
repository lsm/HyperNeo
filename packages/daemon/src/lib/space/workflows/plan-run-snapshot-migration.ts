import type { SpaceWorkflow } from '@hyperneo/shared';
import superpipe, { type Dependencies, type PipelineAPI } from 'superpipe';
import type { AgentTemplateResolver } from './run-template-snapshot.ts';
import { withRunTemplateSnapshots } from './run-template-snapshot.ts';

export interface SnapshotlessPinnedRun {
  id: string;
  workflowId: string;
  payload: string;
  versionHash: string;
}

export type RunSnapshotMigrationSkipKind =
  | 'hash_mismatch'
  | 'invalid_shape'
  | 'already_snapshotted';

export interface RunSnapshotMigrationSkip {
  kind: RunSnapshotMigrationSkipKind;
  message: string;
}

export interface RunSnapshotMigrationPlan {
  runId: string;
  workflowId: string;
  spaceId: string;
  versionHash: string;
  payload: string;
}

export interface PlanRunSnapshotMigrationDeps extends Dependencies {
  verifyVersion(payload: string, versionHash: string): boolean;
  resolveTemplate: AgentTemplateResolver;
  computeVersion(workflow: SpaceWorkflow): { versionHash: string; payload: string };
}

type Gate<T> = { value: T } | { reason: RunSnapshotMigrationSkip };

interface AdmittedRun {
  run: SnapshotlessPinnedRun;
}

interface ParsedRun extends AdmittedRun {
  pinned: SpaceWorkflow;
}

interface SnapshottedRun extends ParsedRun {
  withSnapshots: SpaceWorkflow;
}

function skip(
  kind: RunSnapshotMigrationSkipKind,
  message: string
): {
  reason: RunSnapshotMigrationSkip;
} {
  return { reason: { kind, message } };
}

export function isRunSnapshotMigrationSkip(
  outcome: RunSnapshotMigrationPlan | RunSnapshotMigrationSkip
): outcome is RunSnapshotMigrationSkip {
  return 'kind' in outcome;
}

export function gateIntegrity(
  run: SnapshotlessPinnedRun,
  verifyVersion: PlanRunSnapshotMigrationDeps['verifyVersion']
): Gate<AdmittedRun> {
  if (!verifyVersion(run.payload, run.versionHash)) {
    return skip(
      'hash_mismatch',
      `payload hash mismatch for run ${run.id} (version ${run.versionHash}); leaving it unmigrated`
    );
  }
  return { value: { run } };
}

export function gateShape(admitted: AdmittedRun): Gate<ParsedRun> {
  let pinned: SpaceWorkflow;
  try {
    pinned = JSON.parse(admitted.run.payload) as SpaceWorkflow;
  } catch {
    return skip('invalid_shape', `pinned payload for run ${admitted.run.id} is not valid JSON`);
  }
  if (!pinned || !Array.isArray(pinned.nodes)) {
    return skip('invalid_shape', `pinned payload for run ${admitted.run.id} has no nodes array`);
  }
  return { value: { ...admitted, pinned } };
}

export function gateSnapshots(
  admitted: ParsedRun,
  resolveTemplate: PlanRunSnapshotMigrationDeps['resolveTemplate']
): Gate<SnapshottedRun> {
  const withSnapshots = withRunTemplateSnapshots(admitted.pinned, resolveTemplate);
  if (withSnapshots === admitted.pinned) {
    return skip(
      'already_snapshotted',
      `run ${admitted.run.id} references no templates; nothing to migrate`
    );
  }
  return { value: { ...admitted, withSnapshots } };
}

export function buildPlan(
  admitted: SnapshottedRun,
  computeVersion: PlanRunSnapshotMigrationDeps['computeVersion']
): Gate<RunSnapshotMigrationPlan> {
  const { versionHash, payload } = computeVersion(admitted.withSnapshots);
  return {
    value: {
      runId: admitted.run.id,
      workflowId: admitted.pinned.id,
      spaceId: admitted.pinned.spaceId,
      versionHash,
      payload,
    },
  };
}

export function buildPlanRunSnapshotMigration(
  deps: PlanRunSnapshotMigrationDeps
): (run: SnapshotlessPinnedRun) => RunSnapshotMigrationPlan | RunSnapshotMigrationSkip {
  return (superpipe(deps)('planRunSnapshotMigration') as PipelineAPI)
    .input(['run'])
    .pipe(gateIntegrity, ['run', 'verifyVersion'], 'result:admitted')
    .pipe(gateShape, 'admitted', 'result:admitted')
    .pipe(gateSnapshots, ['admitted', 'resolveTemplate'], 'result:admitted')
    .pipe(buildPlan, ['admitted', 'computeVersion'], 'result:admitted')
    .end('admitted') as (
    run: SnapshotlessPinnedRun
  ) => RunSnapshotMigrationPlan | RunSnapshotMigrationSkip;
}
