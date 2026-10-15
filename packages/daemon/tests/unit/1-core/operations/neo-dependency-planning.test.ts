import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import type { MessageHub } from '@hyperneo/shared';
import type { SDKUserMessage } from '@hyperneo/shared/sdk';
import { z } from 'zod';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import {
  NEO_WORK_ADMISSION_WAKE,
  runNeoAdmissionWake,
} from '../../../../src/lib/neo/admission-wake.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { NEO_EDGES_NEED_APPROVAL } from '../../../../src/lib/neo/work-admission.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const neo: OperationCaller = {
  source: 'mcp',
  sessionId: 'neo:root',
  role: 'neo',
  neoTurn: { messageId: 'epic-1', human: true, isLive: () => true },
};
const place = { machine: 'laptop', folder: tmpdir(), name: 'app' };
const stages = [6757, 6759, 6761];
const issue = (n: number) => `https://github.com/lsm/HyperNeo/issues/${n}`;

type Reply = {
  value?: {
    ok: boolean;
    reason?: string;
    blockers?: unknown[];
    ask?: { id: string; revision?: number };
    work?: { id: string; status: string };
  };
};

describe('dependency planning fixtures', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: NeoService;
  let started: string[];

  beforeEach(async () => {
    db = await createTestDb();
    db.createSession(createTestSession('neo:root'));
    started = [];
    const workStart = defineOperation({
      name: 'work.start',
      description: 'work.start',
      inputSchema: z.record(z.string(), z.unknown()),
      resultSchema: z.unknown(),
      execute: async (input) => {
        started.push(String(input.message));
        return {
          ok: true,
          value: { ref: { adapter: 'codex-desktop', id: `t${started.length}` } },
        };
      },
    });
    const registry = createOperationRegistry([workStart]);
    service = new NeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    Object.assign(service, { returnReport: async () => {}, deliver: mock(async () => {}) });
    service.readRefStates = async (refs) =>
      refs.map((ref) => ({
        url: issue(ref.number),
        kind: 'issue' as const,
        state: 'CLOSED' as const,
        at: 1,
        done: true,
        closedBy: `https://github.com/lsm/HyperNeo/pull/${ref.number + 1}`,
        merges: [{ url: `https://github.com/lsm/HyperNeo/pull/${ref.number + 1}`, base: 'dev' }],
        defaultBase: 'dev',
      }));
    service.readMergeCommit = async () => 'c'.repeat(40);
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    db.getSDKMessageRepo().saveSDKMessage('neo:root', {
      type: 'user',
      uuid: 'epic-1',
      session_id: 'neo:root',
      parent_tool_use_id: null,
      inputKind: 'human',
      message: { role: 'user', content: 'Plan the avatars epic: 6757, then 6759, then 6761.' },
    } as unknown as SDKUserMessage);
  });
  afterEach(() => {
    service.dispose();
    db.close();
  });

  async function invoke(name: string, input: Record<string, unknown>, caller = neo) {
    const askId = input.askId ?? input.id;
    const revision =
      typeof askId === 'string' && ['neo.ask.edit', 'neo.ask.approve'].includes(name)
        ? { expectedRevision: service.askRecords.get(askId)?.revision ?? 0 }
        : {};
    return (await invokeOperation(
      createOperationRegistry(createNeoOperations(service)),
      name,
      { ...revision, ...input },
      caller
    )) as Reply;
  }

  async function planEpic(bound = true) {
    const opened = await invoke('neo.ask.open', {
      requestKey: 'avatars-epic',
      title: 'Avatars epic',
      ask: 'Ship the avatars epic in its three stages.',
      doneSource: 'human',
      pack: 'coding',
      doneItems: stages.map((n) => ({
        text: `lsm/HyperNeo#${n} merged to dev`,
        check: 'coding.pr_merged',
        watch: [issue(n)],
      })),
    });
    const askId = opened.value!.ask!.id;
    const cards: string[] = [];
    for (const [index, n] of stages.entries()) {
      const proposed = await invoke('neo.work.propose', {
        requestKey: `stage-${n}`,
        title: `Close lsm/HyperNeo#${n}`,
        instruction: `Implement ${issue(n)} and merge it to dev.`,
        work: { verb: 'start', adapter: 'codex-desktop', place },
        askId,
        delivers: bound ? [`i${index + 1}`] : [],
      });
      cards.push(proposed.value!.work!.id);
    }
    return { askId, cards };
  }

  test('the coding guidance teaches the staged order Q2 enforces', () => {
    const steps = [
      'check coding.pr_merged, watch the card',
      'neo.work.propose {askId}',
      'bind:[{itemId, deliveredBy: cardId}]',
      'neo.work.start {id, dependsOn:[earlier card ids]}',
      'When it is off (the default),',
      'approve the ask once, after every edge is set',
    ].map((step) => NEO_PACK_CODING_INSTRUCTIONS.indexOf(step));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
  });

  test('a staged epic plan is valid before any pull request exists', async () => {
    const { askId, cards } = await planEpic();
    const [first, second, third] = cards;
    expect(service.askRecords.get(askId)?.doneItems?.map((item) => item.deliveredBy)).toEqual(
      cards
    );
    const blocked = (prerequisite: string) => ({
      value: {
        ok: false,
        reason: 'prerequisites_unmet',
        blockers: [{ workId: prerequisite, reason: 'outcomes_unverified' }],
      },
    });
    expect(service.askRecords.get(askId)?.approvedAt).toEqual(expect.any(Number));
    expect(await invoke('neo.work.start', { id: second, dependsOn: [first] })).toMatchObject({
      value: { ok: false, reason: NEO_EDGES_NEED_APPROVAL },
    });
    expect(service.dependencies.edges()).toEqual([{ workId: second, prerequisiteId: first }]);
    expect(service.askRecords.get(askId)?.approvedAt ?? null).toBeNull();
    expect(await invoke('neo.work.start', { id: second, dependsOn: [first] })).toMatchObject(
      blocked(first)
    );
    expect(await invoke('neo.work.start', { id: third, dependsOn: [second] })).toMatchObject(
      blocked(second)
    );
    expect(await invoke('neo.work.start', { id: first, dependsOn: [third] })).toMatchObject({
      value: { ok: false, reason: 'dependency_cycle' },
    });
    expect(service.dependencies.edges()).toEqual(
      expect.arrayContaining([
        { workId: second, prerequisiteId: first },
        { workId: third, prerequisiteId: second },
      ])
    );
    expect(started).toEqual([]);
    expect(await invoke('neo.work.start', { id: first })).toMatchObject({
      value: { ok: true, work: { status: 'queued' } },
    });
    expect(started).toEqual([expect.stringContaining(issue(6757))]);
    expect([second, third].map((card) => service.repo.getWork(card)?.status)).toEqual([
      'proposed',
      'proposed',
    ]);
    expect([second, third].map((card) => service.dependencies.hasStartIntent(card))).toEqual([
      true,
      true,
    ]);
    expect(service.askRecords.get(askId)?.approvedAt ?? null).toBeNull();

    const item = service.askRecords.get(askId)!.doneItems![0];
    service.askRecords.tickItem(
      askId,
      { ...item, state: 'met', evidence: `${issue(6757)} closed by a merged PR`, metBy: 'daemon' },
      Date.now(),
      item,
      true
    );
    const wake = async () => {
      for (const job of db.getJobQueueRepo().dequeue(NEO_WORK_ADMISSION_WAKE, 10))
        await runNeoAdmissionWake(job, service);
    };
    await wake();
    expect(service.repo.getWork(second)?.status).toBe('proposed');
    expect(started).toHaveLength(1);
    expect(await invoke('neo.work.start', { id: second })).toMatchObject({
      value: { ok: true, work: { status: 'queued' } },
    });
    expect(service.repo.getWork(third)?.status).toBe('proposed');
    expect(started).toHaveLength(2);
  });

  test('with automatic dispatch on, a verified prerequisite starts the next card with Neo idle', async () => {
    const { askId, cards } = await planEpic();
    await invoke('neo.work.start', { id: cards[1], dependsOn: [cards[0]] });
    expect(
      await invoke('neo.ask.approve', { askId }, { source: 'rpc', principal: 'local' })
    ).toMatchObject({ value: { ok: true } });
    db.updateGlobalSettings({ neo: { autoDispatch: true } });
    const item = service.askRecords.get(askId)!.doneItems![0];
    service.askRecords.tickItem(
      askId,
      { ...item, state: 'met', evidence: `${issue(6757)} closed by a merged PR`, metBy: 'daemon' },
      Date.now(),
      item,
      true
    );
    for (const job of db.getJobQueueRepo().dequeue(NEO_WORK_ADMISSION_WAKE, 10))
      await runNeoAdmissionWake(job, service);
    expect(cards.map((card) => service.repo.getWork(card)?.status)).toEqual([
      'queued',
      'queued',
      'queued',
    ]);
    expect(started).toHaveLength(3);
  });

  test('a prerequisite with no bound outcome is refused instead of trusted', async () => {
    const { cards } = await planEpic(false);
    expect(await invoke('neo.work.start', { id: cards[1], dependsOn: [cards[0]] })).toMatchObject({
      value: { ok: false, reason: 'dependency_outcomes_missing' },
    });
    expect(service.dependencies.edges()).toEqual([]);
  });
});
