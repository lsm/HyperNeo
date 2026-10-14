import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoSnapshot } from '@hyperneo/shared/types/neo-snapshot';
import { QueryOptionsBuilder } from '../../../../src/lib/agent/query-options-builder.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { readNeoProjectSnapshot } from '../../../../src/lib/neo/session-policy.ts';
import { NEO_MCP_SNAPSHOT_BUDGET } from '../../../../src/lib/neo/snapshot-compact.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { SettingsManager } from '../../../../src/lib/settings-manager.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

describe('Neo project query snapshot', () => {
  let db: Database;
  let service: NeoService;
  const sessionId = 'neo:project-snapshot';

  beforeEach(async () => {
    db = await createTestDb();
    service = new NeoService(
      db,
      {} as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus()
    );
    for (const id of ['own', 'other']) {
      service.repo.saveProject({ id, title: id, summary: id, context: `${id} context` }, 0);
      service.askRecords.open(
        {
          id: `ask-${id}`,
          requestKey: `ask-${id}`,
          projectId: id,
          originSessionId: sessionId,
          originMessageId: `input-${id}`,
          title: `${id} ask`,
          ask: `${id} human request`,
          doneWhen: 'The outcome is verified',
          doneSource: 'human',
        },
        [{ text: `${id} pending item`, check: 'reported' }]
      );
      service.repo.proposeWork({
        id: `card-${id}`,
        requestKey: `card-${id}`,
        projectId: id,
        originSessionId: sessionId,
        originMessageId: `input-${id}`,
        title: `${id} card`,
        instruction: `${id} instruction`,
      });
    }
    service.repo.reserveBinding({ sessionId, projectId: 'own', kind: 'project' });
    db.updateGlobalSettings({ neo: { standingRules: ['Do not deploy.'] } });
  });

  afterEach(() => {
    service.dispose();
    db.close();
  });

  function read() {
    return readNeoProjectSnapshot(createOperationRegistry(createNeoOperations(service)), sessionId);
  }

  function parse(context: string): NeoSnapshot {
    return JSON.parse(context.slice(context.indexOf('\n') + 1)) as NeoSnapshot;
  }

  test('each fresh query gets current scoped facts without resuming a stored transcript', async () => {
    const session = createTestSession(sessionId);
    session.sdkSessionId = 'old-transcript';
    const builder = new QueryOptionsBuilder({
      db,
      session,
      settingsManager: {
        getGlobalSettings: () => ({}),
        prepareSDKOptions: async () => ({}),
      } as unknown as SettingsManager,
      getNeoProjectSnapshot: read,
      peekPendingResumeSessionAt: () => 'old-rewind-point',
    });
    const first = builder.addSessionStateOptions(await builder.build());
    expect(first.resume).toBeUndefined();
    expect(first.resumeSessionAt).toBeUndefined();
    expect(first.systemPrompt).toMatchObject({
      type: 'custom',
      prompt: expect.stringContaining('own human request'),
    });
    expect(JSON.stringify(first.systemPrompt)).not.toContain('other human request');
    service.repo.saveProject(
      { id: 'own', title: 'own', summary: 'Updated outcome', context: 'Latest durable decision' },
      1
    );
    session.sdkSessionId = 'first-turn-transcript';
    const second = builder.addSessionStateOptions({
      ...(await builder.build()),
      resume: 'inherited-resume',
      resumeSessionAt: 'inherited-rewind',
      continue: true,
      forkSession: true,
    });
    expect(second.resume).toBeUndefined();
    expect(second.resumeSessionAt).toBeUndefined();
    expect(second.continue).toBeUndefined();
    expect(second.forkSession).toBeUndefined();
    expect(JSON.stringify(second.systemPrompt)).toContain('Latest durable decision');
    expect(JSON.stringify(second.systemPrompt)).not.toContain('old-transcript');
    const snapshot = parse(await read());
    expect(snapshot.projects.map((project) => project.id)).toEqual(['own']);
    expect(snapshot.asks?.map((ask) => ask.id)).toEqual(['ask-own']);
    expect(snapshot.asks?.[0].doneItems?.[0]).toMatchObject({
      text: 'own pending item',
      state: 'pending',
    });
    expect(snapshot.cards.map((card) => card.workId)).toEqual(['card-own']);
    expect(snapshot.standingRules).toEqual(['Do not deploy.']);
    expect(await read()).toBe(await read());
  });

  test('the snapshot operation receives the Neo caller identity', async () => {
    const snapshot = createNeoOperations(service).find((entry) => entry.name === 'neo.snapshot')!;
    const execute = mock(snapshot.execute);
    const context = await readNeoProjectSnapshot(
      createOperationRegistry([{ ...snapshot, execute }]),
      sessionId
    );
    expect(execute).toHaveBeenCalledWith({}, { source: 'mcp', sessionId, role: 'neo' });
    expect(parse(context).projects.map((project) => project.id)).toEqual(['own']);
  });

  test('the initial snapshot retains the existing size limit', async () => {
    service.repo.saveProject(
      { id: 'own', title: 'own', summary: '', context: 'Long durable context '.repeat(5000) },
      1
    );
    const snapshot = parse(await read());
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(
      NEO_MCP_SNAPSHOT_BUDGET
    );
    expect(snapshot.trimmed).toBeTruthy();
    expect(snapshot.projects[0].id).toBe('own');
  });

  test('snapshot errors prevent a project query from starting without its facts', async () => {
    await expect(readNeoProjectSnapshot(createOperationRegistry([]), sessionId)).rejects.toThrow(
      'Could not read the fresh Neo project snapshot.'
    );
    const builder = new QueryOptionsBuilder({
      db,
      session: createTestSession(sessionId),
      settingsManager: {
        getGlobalSettings: () => ({}),
        prepareSDKOptions: async () => ({}),
      } as unknown as SettingsManager,
    });
    await expect(builder.build()).rejects.toThrow('Neo project snapshot unavailable.');
  });
});
