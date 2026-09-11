import { describe, expect, test } from 'bun:test';
import type { SpaceAgentTemplate, SpaceWorkflow } from '@hyperneo/shared';
import {
  buildPlanRunSnapshotMigration,
  gateSnapshots,
  gateSource,
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
    loadWorkflow: () => workflow('worker.custom'),
    resolveTemplateFor: () => (key) => (key === 'worker.custom' ? template() : null),
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
      source: 'pinned',
    });
  });

  test('migrates an unverifiable pin from the live definition it already resolves', () => {
    const outcome = run({ verifyVersion: () => false })(candidate());

    expect(isRunSnapshotMigrationSkip(outcome)).toBe(false);
    if (isRunSnapshotMigrationSkip(outcome)) return;
    expect(outcome.source).toBe('live');
  });

  test('migrates a pin whose payload is not valid JSON from the live definition', () => {
    const outcome = run()(candidate({ payload: 'not json' }));

    expect(isRunSnapshotMigrationSkip(outcome)).toBe(false);
    if (isRunSnapshotMigrationSkip(outcome)) return;
    expect(outcome.source).toBe('live');
  });

  test('skips only when neither the pin nor the live workflow is usable', () => {
    const outcome = run({ verifyVersion: () => false, loadWorkflow: () => null })(candidate());

    expect(isRunSnapshotMigrationSkip(outcome) && outcome.kind).toBe('unusable_definition');
  });

  test('stamps a record for a template-free run so it is not rescanned', () => {
    const outcome = run()(candidate({ payload: JSON.stringify(workflow()) }));

    expect(isRunSnapshotMigrationSkip(outcome)).toBe(false);
  });

  test('still plans when the template does not resolve, pinning an empty record', () => {
    const outcome = run({ resolveTemplateFor: () => () => null })(candidate());

    expect(isRunSnapshotMigrationSkip(outcome)).toBe(false);
  });
});

describe('planRunSnapshotMigration gates', () => {
  test('gateSource prefers a verified pin over the live definition', () => {
    const outcome = gateSource(
      candidate(),
      () => true,
      () => workflow()
    );

    expect('value' in outcome && outcome.value.source).toBe('pinned');
  });

  test('gateSource falls back to live when the pin does not verify', () => {
    const outcome = gateSource(
      candidate(),
      () => false,
      () => workflow()
    );

    expect('value' in outcome && outcome.value.source).toBe('live');
  });

  test('gateSource names the run and version when nothing is usable', () => {
    const outcome = gateSource(
      candidate(),
      () => false,
      () => null
    );

    expect('reason' in outcome && outcome.reason.message).toContain('run-1');
    expect('reason' in outcome && outcome.reason.message).toContain('vh-1');
  });

  test('gateSnapshots always attaches a record, even with no template slots', () => {
    const outcome = gateSnapshots(
      { run: candidate(), definition: workflow(), source: 'pinned' },
      () => null
    );

    expect('value' in outcome && outcome.value.withSnapshots.templateSnapshots).toEqual({});
  });
});
