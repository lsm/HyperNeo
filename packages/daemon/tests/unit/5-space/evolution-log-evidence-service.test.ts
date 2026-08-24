import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat';
import type { CreateEvidenceRefParams, StructuredLogEvent } from '@hyperneo/shared';
import {
  EvolutionLogEvidenceService,
  PRODUCT_FORGE_SCOPE_ID,
} from '../../../src/lib/space/evolution-log-evidence-service';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import type { EvidenceRef } from '@hyperneo/shared';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('EvolutionLogEvidenceService', () => {
  let db: Database;
  let evolutionRepo: EvolutionRepository;
  let scopeId: string;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    const spaceRepo = new SpaceRepository(db as never);
    evolutionRepo = new EvolutionRepository(db as never);
    spaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/log-evidence',
      slug: 'log-evidence',
      name: 'Log Evidence',
    }).id;
    scopeId = evolutionRepo.createScope({
      spaceId,
      kind: 'project',
      name: 'HyperNeo product',
      objective: 'Capture daemon warnings and errors',
    }).id;
  });

  it('creates evidence for error-level log events', () => {
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      subscriptions: [{ scopeId, levels: ['error'] }],
    });

    service.capture(
      createEvent({
        level: 'error',
        message: 'MCP connection failed',
        stack: 'Error: MCP connection failed\n    at connect',
      })
    );
    service.flush();

    const evidence = evolutionRepo.listEvidence(scopeId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].kind).toBe('daemon_error');
    expect(evidence[0].summary).toContain('MCP connection failed');
    expect(evidence[0].metadata.stack).toContain('at connect');
    expect(evidence[0].metadata.context).toEqual({ spaceId: 'space-1', sessionId: 'session-1' });
    expect(evidence[0].metadata.process).toMatchObject({ pid: 123 });
  });

  it('deduplicates identical signatures within the window', () => {
    let listEvidenceCalls = 0;
    let findLatestEvidenceBySourceCalls = 0;
    const repo = Object.create(evolutionRepo) as EvolutionRepository & {
      findLatestEvidenceBySource(scopeId: string, sourceId: string): EvidenceRef | null;
    };
    repo.listEvidence = (...args) => {
      listEvidenceCalls += 1;
      return evolutionRepo.listEvidence(...args);
    };
    repo.findLatestEvidenceBySource = (...args) => {
      findLatestEvidenceBySourceCalls += 1;
      return evolutionRepo.findLatestEvidenceBySource(...args);
    };
    const service = new EvolutionLogEvidenceService({
      evolutionRepo: repo,
      subscriptions: [{ scopeId, levels: ['warn'] }],
      dedupeWindowMs: 60_000,
    });

    service.capture(createEvent({ level: 'warn', message: 'session dropped 12345678901' }));
    service.capture(createEvent({ level: 'warn', message: 'session dropped 99999999999' }));
    service.flush();

    const evidence = evolutionRepo.listEvidence(scopeId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].kind).toBe('runtime_warning');
    expect(evidence[0].metadata.count).toBe(2);
    expect(evidence[0].metadata.samples).toHaveLength(2);
    expect(findLatestEvidenceBySourceCalls).toBe(2);
    expect(listEvidenceCalls).toBe(0);
  });

  it('resolves default product scope dynamically when the fixed scope is absent', () => {
    const dynamicSpaceId = new SpaceRepository(db as never).createSpace({
      workspacePath: '/workspace/log-evidence-dynamic',
      slug: 'log-evidence-dynamic',
      name: 'Log Evidence Dynamic',
    }).id;
    let listSpacesCalls = 0;
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      spaceRepo: {
        listSpaces: (includeArchived?: boolean) => {
          listSpacesCalls += 1;
          expect(includeArchived).toBe(false);
          return [{ id: dynamicSpaceId }] as never;
        },
      },
      subscriptionRefreshMs: 0,
    });
    expect(evolutionRepo.getScope(PRODUCT_FORGE_SCOPE_ID)).toBeNull();

    service.capture(createEvent({ level: 'error', message: 'dynamic scope failure' }));
    service.capture(createEvent({ level: 'warn', message: 'dynamic scope warning' }));
    service.flush();

    const scope = evolutionRepo
      .listScopes({ spaceId: dynamicSpaceId })
      .find((item) => item.policy.logEvidenceProductScope === true);
    expect(scope).toBeTruthy();
    expect(evolutionRepo.listEvidence(scope!.id)).toHaveLength(2);
    expect(listSpacesCalls).toBe(1);
  });

  it('refreshes empty default subscriptions when spaces are created later', () => {
    let spaces: { id: string }[] = [];
    let listSpacesCalls = 0;
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      spaceRepo: {
        listSpaces: (includeArchived?: boolean) => {
          listSpacesCalls += 1;
          expect(includeArchived).toBe(false);
          return spaces as never;
        },
      },
      subscriptionRefreshMs: 0,
    });

    service.capture(createEvent({ level: 'error', message: 'before space exists' }));
    service.flush();
    expect(listSpacesCalls).toBe(1);

    const laterSpaceId = new SpaceRepository(db as never).createSpace({
      workspacePath: '/workspace/log-evidence-later',
      slug: 'log-evidence-later',
      name: 'Log Evidence Later',
    }).id;
    spaces = [{ id: laterSpaceId }];

    service.capture(createEvent({ level: 'error', message: 'after space exists' }));
    service.flush();

    const scope = evolutionRepo
      .listScopes({ spaceId: laterSpaceId })
      .find((item) => item.policy.logEvidenceProductScope === true);
    expect(scope).toBeTruthy();
    expect(evolutionRepo.listEvidence(scope!.id)).toHaveLength(1);
    expect(listSpacesCalls).toBe(2);
  });

  it('caches default subscriptions between log events', () => {
    const firstSpaceId = new SpaceRepository(db as never).createSpace({
      workspacePath: '/workspace/log-evidence-first',
      slug: 'log-evidence-first',
      name: 'Log Evidence First',
    }).id;
    let listSpacesCalls = 0;
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      spaceRepo: {
        listSpaces: () => {
          listSpacesCalls += 1;
          return [{ id: firstSpaceId }] as never;
        },
      },
      subscriptionRefreshMs: 60_000,
    });

    service.capture(createEvent({ level: 'error', message: 'first cached error' }));
    service.capture(createEvent({ level: 'error', message: 'second cached error' }));
    service.flush();

    const firstScope = evolutionRepo
      .listScopes({ spaceId: firstSpaceId })
      .find((item) => item.policy.logEvidenceProductScope === true);
    expect(firstScope).toBeTruthy();
    expect(evolutionRepo.listEvidence(firstScope!.id)).toHaveLength(2);
    expect(listSpacesCalls).toBe(1);
  });

  it('refreshes default subscriptions after the refresh interval', () => {
    const firstSpaceId = new SpaceRepository(db as never).createSpace({
      workspacePath: '/workspace/log-evidence-first',
      slug: 'log-evidence-first',
      name: 'Log Evidence First',
    }).id;
    let spaces = [{ id: firstSpaceId }];
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      spaceRepo: {
        listSpaces: () => spaces as never,
      },
      subscriptionRefreshMs: 0,
    });

    service.capture(createEvent({ level: 'error', message: 'first space error' }));
    service.flush();
    const firstScope = evolutionRepo
      .listScopes({ spaceId: firstSpaceId })
      .find((item) => item.policy.logEvidenceProductScope === true);
    expect(firstScope).toBeTruthy();
    expect(evolutionRepo.listEvidence(firstScope!.id)).toHaveLength(1);

    const secondSpaceId = new SpaceRepository(db as never).createSpace({
      workspacePath: '/workspace/log-evidence-second',
      slug: 'log-evidence-second',
      name: 'Log Evidence Second',
    }).id;
    spaces = [{ id: firstSpaceId }, { id: secondSpaceId }];

    service.capture(createEvent({ level: 'error', message: 'second space error' }));
    service.flush();

    const secondScope = evolutionRepo
      .listScopes({ spaceId: secondSpaceId })
      .find((item) => item.policy.logEvidenceProductScope === true);
    expect(secondScope).toBeTruthy();
    expect(evolutionRepo.listEvidence(secondScope!.id)).toHaveLength(1);
  });

  it('drops archived spaces from refreshed default subscriptions', () => {
    const spaceRepo = new SpaceRepository(db as never);
    const activeSpaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/log-evidence-active',
      slug: 'log-evidence-active',
      name: 'Log Evidence Active',
    }).id;
    const archivedSpaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/log-evidence-archived',
      slug: 'log-evidence-archived',
      name: 'Log Evidence Archived',
    }).id;
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      spaceRepo,
      subscriptionRefreshMs: 0,
    });

    service.capture(createEvent({ level: 'error', message: 'before archive' }));
    service.flush();
    const archivedScope = evolutionRepo
      .listScopes({ spaceId: archivedSpaceId })
      .find((item) => item.policy.logEvidenceProductScope === true);
    expect(archivedScope).toBeTruthy();
    spaceRepo.archiveSpace(archivedSpaceId);

    service.capture(createEvent({ level: 'error', message: 'after archive' }));
    service.flush();

    const activeScope = evolutionRepo
      .listScopes({ spaceId: activeSpaceId })
      .find((item) => item.policy.logEvidenceProductScope === true);
    expect(activeScope).toBeTruthy();
    expect(evolutionRepo.listEvidence(activeScope!.id)).toHaveLength(2);
    expect(evolutionRepo.listEvidence(archivedScope!.id)).toHaveLength(1);
  });

  it('replaces dynamic scopes when the fixed product scope appears', () => {
    const spaceRepo = new SpaceRepository(db as never);
    const dynamicSpaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/log-evidence-dynamic-fixed',
      slug: 'log-evidence-dynamic-fixed',
      name: 'Log Evidence Dynamic Fixed',
    }).id;
    const fixedSpaceId = spaceRepo.createSpace({
      workspacePath: '/workspace/log-evidence-fixed',
      slug: 'log-evidence-fixed',
      name: 'Log Evidence Fixed',
    }).id;
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      spaceRepo,
      subscriptionRefreshMs: 0,
    });

    service.capture(createEvent({ level: 'error', message: 'dynamic before fixed' }));
    service.flush();
    const dynamicScope = evolutionRepo
      .listScopes({ spaceId: dynamicSpaceId })
      .find((item) => item.policy.logEvidenceProductScope === true);
    expect(dynamicScope).toBeTruthy();

    db.prepare(
      `INSERT INTO evolution_scopes (
				id, space_id, space_goal_id, kind, name, objective, parent_scope_id,
				metric_definitions_json, policy_json, created_at, updated_at
			) VALUES (?, ?, NULL, 'project', 'Fixed product scope', 'Fixed scope', NULL, '[]', '{}', ?, ?)`
    ).run(PRODUCT_FORGE_SCOPE_ID, fixedSpaceId, Date.now(), Date.now());

    service.capture(createEvent({ level: 'error', message: 'fixed after refresh' }));
    service.flush();

    expect(evolutionRepo.listEvidence(dynamicScope!.id)).toHaveLength(1);
    expect(evolutionRepo.listEvidence(PRODUCT_FORGE_SCOPE_ID)).toHaveLength(1);
  });

  it('limits source lookup to the latest matching evidence', () => {
    evolutionRepo.createEvidence({
      scopeId,
      kind: 'daemon_error',
      sourceId: 'log:manual-old',
      summary: 'old same source',
      metadata: { autoCaptured: true, logFingerprint: 'manual-old' },
      createdAt: 1,
    });
    evolutionRepo.createEvidence({
      scopeId,
      kind: 'daemon_error',
      sourceId: 'log:manual-old',
      summary: 'new same source',
      metadata: { autoCaptured: true, logFingerprint: 'manual-old' },
      createdAt: 2,
    });

    const latest = evolutionRepo.findLatestEvidenceBySource(scopeId, 'log:manual-old');

    expect(latest?.summary).toBe('new same source');
  });

  it('uses process event metadata in dedupe fingerprints', () => {
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      subscriptions: [{ scopeId, levels: ['fatal'] }],
      dedupeWindowMs: 60_000,
    });
    const stack = 'Error: same crash\n    at crash';

    service.capture(createEvent({ level: 'fatal', message: 'same crash', stack }));
    service.capture(
      createEvent({
        level: 'fatal',
        message: 'same crash',
        stack,
        metadata: { processEvent: 'uncaughtException' },
      })
    );
    service.flush();

    const evidence = evolutionRepo.listEvidence(scopeId);
    expect(evidence).toHaveLength(2);
    expect(evidence.map((item) => item.kind).sort()).toEqual([
      'runtime_crash',
      'uncaught_exception',
    ]);
  });

  it('classifies process crash events by processEvent metadata', () => {
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      subscriptions: [{ scopeId, levels: ['fatal'] }],
    });

    service.capture(
      createEvent({
        level: 'fatal',
        message: 'uncaught exception',
        metadata: { processEvent: 'uncaughtException' },
      })
    );
    service.flush();

    expect(evolutionRepo.listEvidence(scopeId)[0].kind).toBe('uncaught_exception');
  });

  it('does not capture unsubscribed levels and redacts secrets', () => {
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      subscriptions: [{ scopeId, levels: ['error'] }],
    });

    service.capture(createEvent({ level: 'info', message: 'startup ok' }));
    service.capture(
      createEvent({
        level: 'error',
        message: 'config failed token=secret-value',
        metadata: { apiKey: 'sk-test-secret' },
      })
    );
    service.flush();

    const evidence = evolutionRepo.listEvidence(scopeId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].summary).not.toContain('secret-value');
    expect(evidence[0].summary).toContain('token=[REDACTED]');
    expect(JSON.stringify(evidence[0].metadata)).not.toContain('sk-test-secret');
    expect(JSON.stringify(evidence[0].metadata)).not.toContain('secret-value');
    expect(JSON.stringify(evidence[0].metadata)).toContain('[REDACTED]');
  });

  it('emits warn-heavy bursts without blocking on a contended DB writer', async () => {
    const CONTEND_MS = 15;
    let blockedCalls = 0;
    const sleepSync = (ms: number): void => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    };
    const contend = <T>(write: () => T): T => {
      sleepSync(CONTEND_MS);
      blockedCalls += 1;
      return write();
    };
    const repo = Object.create(evolutionRepo) as EvolutionRepository;
    repo.getScope = (id: string) => contend(() => evolutionRepo.getScope(id));
    repo.listScopes = (params: Parameters<EvolutionRepository['listScopes']>[0]) =>
      contend(() => evolutionRepo.listScopes(params));
    repo.createScope = (params: Parameters<EvolutionRepository['createScope']>[0]) =>
      contend(() => evolutionRepo.createScope(params));
    repo.findLatestEvidenceBySource = (scopeId: string, sourceId: string) =>
      contend(() => evolutionRepo.findLatestEvidenceBySource(scopeId, sourceId));
    repo.updateEvidence = (
      id: string,
      params: Pick<CreateEvidenceRefParams, 'summary' | 'metadata'>
    ) => contend(() => evolutionRepo.updateEvidence(id, params));
    repo.createEvidence = (params: CreateEvidenceRefParams) =>
      contend(() => evolutionRepo.createEvidence(params));
    const underlyingSpaceRepo = new SpaceRepository(db as never);
    const contendedSpaceRepo = Object.create(underlyingSpaceRepo) as SpaceRepository;
    contendedSpaceRepo.listSpaces = (includeArchived?: boolean) =>
      contend(() => underlyingSpaceRepo.listSpaces(includeArchived));
    const service = new EvolutionLogEvidenceService({
      evolutionRepo: repo,
      spaceRepo: contendedSpaceRepo,
      flushDelayMs: 60_000,
    });
    const productScopeFor = () =>
      evolutionRepo
        .listScopes({ spaceId })
        .find((scope) => scope.policy.logEvidenceProductScope === true);

    const startedAt = Date.now();
    for (let i = 0; i < 12; i++) {
      service.capture(createEvent({ level: 'warn', message: `contended warning ${i}` }));
    }
    const inlineRepoCalls = blockedCalls;
    const emissionMs = Date.now() - startedAt;

    expect(inlineRepoCalls).toBe(0);
    expect(emissionMs).toBeLessThan(250);
    expect(productScopeFor()).toBeUndefined();

    await service.flushAsync();

    expect(blockedCalls).toBeGreaterThan(inlineRepoCalls);
    expect(productScopeFor()).toBeTruthy();
    expect(evolutionRepo.listEvidence(productScopeFor()!.id)).toHaveLength(12);
  });

  it('drains captured evidence on the deferred timer without an explicit flush', async () => {
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      subscriptions: [{ scopeId, levels: ['warn'] }],
      flushDelayMs: 20,
    });

    service.capture(createEvent({ level: 'warn', message: 'timer drained warning' }));

    const deadline = Date.now() + 2000;
    while (evolutionRepo.listEvidence(scopeId).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(evolutionRepo.listEvidence(scopeId)).toHaveLength(1);
    await service.flushAsync();
  });

  it('does not let unsubscribed log levels evict buffered evidence', async () => {
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      subscriptions: [{ scopeId, levels: ['warn'] }],
      maxBufferedEvents: 5,
      flushDelayMs: 60_000,
    });

    service.capture(createEvent({ level: 'warn', message: 'kept warning' }));
    for (let i = 0; i < 20; i++) {
      service.capture(createEvent({ level: 'info', message: `noise ${i}` }));
    }

    await service.flushAsync();

    expect(evolutionRepo.listEvidence(scopeId)).toHaveLength(1);
    expect(evolutionRepo.listEvidence(scopeId)[0].summary).toContain('kept warning');
  });

  it('does not let non-matching events evict pattern-matched evidence', async () => {
    const service = new EvolutionLogEvidenceService({
      evolutionRepo,
      subscriptions: [{ scopeId, levels: ['warn'], patterns: [/^payment:/] }],
      maxBufferedEvents: 5,
      flushDelayMs: 60_000,
    });

    service.capture(createEvent({ level: 'warn', message: 'payment: kept failure' }));
    for (let i = 0; i < 20; i++) {
      service.capture(createEvent({ level: 'warn', message: `unrelated noise ${i}` }));
    }

    await service.flushAsync();

    expect(evolutionRepo.listEvidence(scopeId)).toHaveLength(1);
    expect(evolutionRepo.listEvidence(scopeId)[0].summary).toContain('payment:');
  });

  it('does not double-write evidence when flush interrupts an active drain', async () => {
    const sleepSync = (ms: number): void => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    };
    const repo = Object.create(evolutionRepo) as EvolutionRepository;
    repo.getScope = (id: string) => {
      sleepSync(10);
      return evolutionRepo.getScope(id);
    };
    const service = new EvolutionLogEvidenceService({
      evolutionRepo: repo,
      subscriptions: [{ scopeId, levels: ['warn'] }],
      flushDelayMs: 60_000,
    });

    service.capture(createEvent({ level: 'warn', message: 'raced warning' }));
    const drain = service.flushAsync();
    await new Promise((resolve) => setTimeout(resolve, 1));
    service.flush();
    await drain;

    const evidence = evolutionRepo.listEvidence(scopeId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].metadata.count).toBe(1);
  });

  it('keeps flush non-throwing when subscription resolution fails', () => {
    const repo = Object.create(evolutionRepo) as EvolutionRepository;
    repo.listScopes = () => {
      throw new Error('database is locked');
    };
    const failingSpaceRepo = Object.create(new SpaceRepository(db as never)) as SpaceRepository;
    failingSpaceRepo.listSpaces = () => {
      throw new Error('database is locked');
    };
    repo.getScope = () => {
      throw new Error('database is locked');
    };
    const service = new EvolutionLogEvidenceService({
      evolutionRepo: repo,
      spaceRepo: failingSpaceRepo,
      subscriptionRefreshMs: 0,
    });

    service.capture(createEvent({ level: 'warn', message: 'locked out warning' }));

    expect(() => service.flush()).not.toThrow();
  });
});

function createEvent(overrides: Partial<StructuredLogEvent>): StructuredLogEvent {
  return {
    id: `event-${Math.random()}`,
    timestamp: Date.now(),
    level: 'error',
    message: 'daemon error',
    module: 'hyperneo:daemon:test',
    source: 'logger',
    context: { spaceId: 'space-1', sessionId: 'session-1' },
    process: {
      pid: 123,
      memory: { rss: 1, heapTotal: 1, heapUsed: 1, external: 0, arrayBuffers: 0 },
      uptime: 5,
    },
    metadata: {},
    ...overrides,
  };
}
