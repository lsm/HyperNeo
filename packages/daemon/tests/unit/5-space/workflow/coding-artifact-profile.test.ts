import { describe, expect, test } from 'bun:test';
import type { WorkflowRunArtifactRecord } from '../../../../src/storage/repositories/workflow-run-artifact-repository';
import { CodingArtifactProfile } from '../../../../src/lib/space/workflows/coding-artifact-profile';

interface FakeRepo {
  listByRun(
    runId: string,
    filters?: { nodeId?: string; artifactType?: string }
  ): WorkflowRunArtifactRecord[];
}

function makeProfile(rows: WorkflowRunArtifactRecord[]): CodingArtifactProfile {
  const repo: FakeRepo = { listByRun: () => rows };
  // CodingArtifactProfileConfig only needs artifactRepo (structural type — a fake suffices)
  return new CodingArtifactProfile({ artifactRepo: repo as unknown as never });
}

const row = (
  partial: Partial<WorkflowRunArtifactRecord> &
    Pick<WorkflowRunArtifactRecord, 'artifactType' | 'artifactKey'>
): WorkflowRunArtifactRecord => ({
  id: 'id',
  runId: 'run-1',
  nodeId: 'node-1',
  data: {},
  createdAt: 0,
  updatedAt: 0,
  ...partial,
});

describe('CodingArtifactProfile PR-identity resolution', () => {
  test('resolves the engine-stamped __pr_validated__ artifact (the merge-gate P1 regression)', () => {
    // pr_ready stamps { artifactType:'link', artifactKey:'__pr_validated__', data:{ link, kind:'pr' } }.
    // prUrlOf must recognize that key, else resolveInitialPrimaryLinkUrl returns '' and the
    // merge gate (requirePrUrl:true) fails closed on every v2 run.
    const profile = makeProfile([
      row({
        artifactType: 'link',
        artifactKey: '__pr_validated__',
        data: { link: 'https://github.com/o/r/pull/9', kind: 'pr' },
        updatedAt: 5,
      }),
    ]);
    expect(profile.resolveInitialPrimaryLinkUrl('run-1')).toBe('https://github.com/o/r/pull/9');
    expect(profile.resolvePrimaryLinkUrl('run-1')).toBe('https://github.com/o/r/pull/9');
  });

  test('merge gate binds to the EARLIEST validated stamp (PR-swap resistant)', () => {
    const profile = makeProfile([
      row({
        artifactType: 'link',
        artifactKey: '__pr_validated__',
        data: { link: 'https://github.com/o/r/pull/1' },
        updatedAt: 100,
      }),
      // a later validated stamp on a different node — must not swap the identity
      row({
        artifactType: 'link',
        artifactKey: '__pr_validated__',
        data: { link: 'https://github.com/o/r/pull/2' },
        updatedAt: 999,
        nodeId: 'node-2',
      }),
    ]);
    expect(profile.resolveInitialPrimaryLinkUrl('run-1')).toBe('https://github.com/o/r/pull/1');
  });

  test('falls back to an agent-written link/pr before the first handoff (legacy compat)', () => {
    const profile = makeProfile([
      row({
        artifactType: 'link',
        artifactKey: 'pr',
        data: { url: 'https://github.com/o/r/pull/3', kind: 'pr' },
        updatedAt: 1,
      }),
    ]);
    expect(profile.resolveInitialPrimaryLinkUrl('run-1')).toBe('https://github.com/o/r/pull/3');
  });

  test('falls back to a decision-artifact pr_url (post-approval routing compat)', () => {
    const profile = makeProfile([
      row({
        artifactType: 'decision',
        artifactKey: 'merge',
        data: { pr_url: 'https://github.com/o/r/pull/4' },
        updatedAt: 1,
      }),
    ]);
    expect(profile.resolvePrimaryLinkUrl('run-1')).toBe('https://github.com/o/r/pull/4');
  });

  test('prefers the validated identity over agent-written link/pr', () => {
    const profile = makeProfile([
      row({
        artifactType: 'link',
        artifactKey: 'pr',
        data: { url: 'https://github.com/o/r/pull/WRONG', kind: 'pr' },
        updatedAt: 999,
      }),
      row({
        artifactType: 'link',
        artifactKey: '__pr_validated__',
        data: { link: 'https://github.com/o/r/pull/RIGHT' },
        updatedAt: 1,
      }),
    ]);
    expect(profile.resolvePrimaryLinkUrl('run-1')).toBe('https://github.com/o/r/pull/RIGHT');
  });

  test('returns "" when there is no PR artifact', () => {
    const profile = makeProfile([
      row({
        artifactType: 'note',
        artifactKey: 'current',
        data: { summary: 'working' },
        updatedAt: 1,
      }),
    ]);
    expect(profile.resolvePrimaryLinkUrl('run-1')).toBe('');
    expect(profile.resolveInitialPrimaryLinkUrl('run-1')).toBe('');
  });

  test('summarizeRunOutcome reads the kindless terminal decision', () => {
    const profile = makeProfile([
      row({
        artifactType: 'decision',
        artifactKey: 'r1',
        data: { kind: 'review', summary: 'review decided' },
        updatedAt: 1,
      }),
      row({
        artifactType: 'decision',
        artifactKey: 'r2',
        data: { summary: 'merged and done' },
        updatedAt: 2,
      }),
    ]);
    expect(profile.summarizeRunOutcome('run-1')).toBe('merged and done');
  });
});
