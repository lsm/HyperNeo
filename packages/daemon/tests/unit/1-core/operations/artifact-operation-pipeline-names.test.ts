import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createArtifactReadOperations } from '../../../../src/lib/artifacts/read-operations';
import { createArtifactReferenceResolve } from '../../../../src/lib/artifacts/resolve-operation';
import { Database } from '../../../../src/storage/sqlite-compat';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';

const entered = vi.hoisted(() => [] as string[]);
const storedPlan = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

vi.mock('../../../../src/lib/artifacts/reference-plan', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../../../../src/lib/artifacts/reference-plan')>();
  return {
    ...real,
    planStoredReference: (...args: Parameters<typeof real.planStoredReference>) =>
      storedPlan.value === undefined
        ? real.planStoredReference(...args)
        : Promise.resolve(storedPlan.value),
  };
});

const noDatabase = () => {
  throw new Error('no database in this test');
};
const agent: OperationCaller = { source: 'mcp', role: 'long_term_agent' };
const human: OperationCaller = { source: 'rpc', principal: 'local' };

const operations = [
  ...createArtifactReadOperations(noDatabase, '/nonexistent'),
  createArtifactReferenceResolve(noDatabase, '/nonexistent', '/nonexistent'),
];

function expectNamedFor(operation: string) {
  expect(entered[0]).toBe(operation);
  for (const helper of entered.slice(1)) {
    expect(helper.startsWith(`${operation}.`)).toBe(true);
  }
}

describe('artifact operations', () => {
  test('covers every artifact operation', () => {
    expect(operations.map((operation) => operation.name).sort()).toEqual([
      'artifact.file.get',
      'artifact.file.html',
      'artifact.file.list',
      'artifact.file.read',
      'artifact.reference.resolve',
    ]);
  });

  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve(operation.execute({ artifactId: 'artifact-1' } as never, agent)).catch(
        () => undefined
      );
      expectNamedFor(operation.name);
    }
  );
});

describe('artifact.reference.resolve for the local human', () => {
  let main: Database;
  let worker: Database;
  let gateway: DbGateway;
  let root: string;
  const input = {
    requestId: '11111111-1111-4111-8111-111111111111',
    sourceMessageOrCard: { kind: 'todo' as const, id: 'synthetic' },
    reference: 'report.md',
  };

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-pipeline-names-')));
    main = new Database(':memory:');
    worker = new Database(':memory:');
    runMigrations(main, () => {});
    createTables(main);
    worker.exec(
      'CREATE TABLE artifact_file_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), daemon_id TEXT NOT NULL)'
    );
    gateway = new DbGateway(':memory:', worker);
    bindGateway(main, gateway);
    entered.length = 0;
    storedPlan.value = undefined;
  });

  afterEach(async () => {
    storedPlan.value = undefined;
    await gateway.close();
    main.close();
    worker.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('plans the stored reference in a step of the operation', async () => {
    const operation = createArtifactReferenceResolve(() => main, root, join(root, 'home'));
    expect(await operation.execute(input, human)).toEqual({
      accepted: false,
      reason: 'unavailable',
    });
    expect(entered).toContain('artifact.reference.resolve.plan');
    expectNamedFor('artifact.reference.resolve');
  });

  test('captures a Git file in a step of the operation', async () => {
    storedPlan.value = {
      accepted: true,
      kind: 'git-blob',
      context: { kind: 'todo', id: 'synthetic' },
      repository: 'github.com/example/demo',
      sha: 'a'.repeat(40),
      path: 'docs/report.md',
    };
    const operation = createArtifactReferenceResolve(
      () => main,
      root,
      join(root, 'home'),
      undefined,
      async () => ({ accepted: false, reason: 'unavailable' })
    );
    expect(await operation.execute(input, human)).toEqual({
      accepted: false,
      reason: 'unavailable',
    });
    expect(entered).toContain('artifact.reference.resolve.capture');
    expectNamedFor('artifact.reference.resolve');
  });
});
