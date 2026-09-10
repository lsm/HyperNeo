import { describe, expect, test } from 'bun:test';
import type { SpaceAgentTemplate, SpaceWorkflow } from '@hyperneo/shared';
import {
  buildPlanRunSnapshotMigration,
  gateIntegrity,
  gateShape,
  gateSnapshots,
  isRunSnapshotMigrationSkip,
  type SnapshotlessPinnedRun,
} from '../../../../src/lib/space/workflows/plan-run-snapshot-migration.ts';

function template(): SpaceAgentTemplate {
  return {
    key: 'worker.custom',
    handle: 'custom-worker',
    displayName: 'Custom Worker',
    description: null,
    instructions: 'Frozen.',
    suggestedAutonomyLevel: 2,
    model: null,
    provider: null,
    modelPool: null,
    thinkingLevel: null,
    settingSources: null,
    tools: null,
    labels: [],
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SpaceAgentTemplate;
}

function workflow(templateKey?: string): SpaceWorkflow {
  return {
    id: 'wf-1',
    spaceId: 'space-1',
    name: 'Flow',
    nodes: [
      {
        id: 'n1',
        name: 'Build',
        agents: [{ agentId: '', name: 'Worker', ...(templateKey ? { templateKey } : {}) }],
      },
    ],
    startNodeId: 'n1',
    tags: [],
    completionAutonomyLevel: 3,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as SpaceWorkflow;
}

function candidate(overrides: Partial<SnapshotlessPinnedRun> = {}): SnapshotlessPinnedRun {
  return {
    id: 'run-1',
    workflowId: 'wf-1',
    payload: JSON.stringify(workflow('worker.custom')),
    versionHash: 'vh-1',
    ...overrides,
  };
}

function run(deps: Partial<Parameters<typeof buildPlanRunSnapshotMigration>[0]> = {}) {
  return buildPlanRunSnapshotMigration({
    verifyVersion: () => true,
    resolveTemplate: (key) => (key === 'worker.custom' ? template() : null),
    computeVersion: () => ({ versionHash: 'vh-2', payload: 'migrated-payload' }),
    ...deps,
  });
}

describe('planRunSnapshotMigration', () => {
  test('plans a migration for a verified snapshot-less pin', () => {
    const outcome = run()(candidate());

    expect(isRunSnapshotMigrationSkip(outcome)).toBe(false);
    if (isRunSnapshotMigrationSkip(outcome)) return;
    expect(outcome).toEqual({
      runId: 'run-1',
      workflowId: 'wf-1',
      spaceId: 'space-1',
      versionHash: 'vh-2',
      payload: 'migrated-payload',
    });
  });

  test('skips a pin whose payload hash does not verify, before parsing it', () => {
    let parsed = false;
    const outcome = run({
      verifyVersion: () => false,
      resolveTemplate: () => {
        parsed = true;
        return null;
      },
    })(candidate());

    expect(isRunSnapshotMigrationSkip(outcome) && outcome.kind).toBe('hash_mismatch');
    expect(parsed).toBe(false);
  });

  test('skips a pin whose payload is not valid JSON', () => {
    const outcome = run()(candidate({ payload: 'not json' }));

    expect(isRunSnapshotMigrationSkip(outcome) && outcome.kind).toBe('invalid_shape');
  });

  test('skips a pin whose payload has no nodes array', () => {
    const outcome = run()(candidate({ payload: JSON.stringify({ id: 'wf-1' }) }));

    expect(isRunSnapshotMigrationSkip(outcome) && outcome.kind).toBe('invalid_shape');
  });

  test('skips a run that references no templates', () => {
    const outcome = run()(candidate({ payload: JSON.stringify(workflow()) }));

    expect(isRunSnapshotMigrationSkip(outcome) && outcome.kind).toBe('already_snapshotted');
  });

  test('still plans when the template does not resolve, pinning an empty record', () => {
    const outcome = run({ resolveTemplate: () => null })(candidate());

    expect(isRunSnapshotMigrationSkip(outcome)).toBe(false);
  });
});

describe('planRunSnapshotMigration gates', () => {
  test('gateIntegrity names the run and version in its skip reason', () => {
    const outcome = gateIntegrity(candidate(), () => false);

    expect('reason' in outcome && outcome.reason.message).toContain('run-1');
    expect('reason' in outcome && outcome.reason.message).toContain('vh-1');
  });

  test('gateShape admits a valid payload', () => {
    const outcome = gateShape({ run: candidate() });

    expect('value' in outcome && outcome.value.pinned.id).toBe('wf-1');
  });

  test('gateSnapshots rejects an unchanged workflow by identity', () => {
    const parsed = { run: candidate(), pinned: workflow() };
    const outcome = gateSnapshots(parsed, () => null);

    expect('reason' in outcome && outcome.reason.kind).toBe('already_snapshotted');
  });
});
