import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import type { NeoDriverTarget } from '../../../../src/lib/neo/driver-work.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import type { NeoRefState } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import { readCodingPrerequisiteBase } from '../../../../src/lib/neo/packs/coding/prerequisite-base.ts';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  defineOperation,
} from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const merge = 'a'.repeat(40);
const item = (watch: string[], extra: Partial<NeoAskItem> = {}): NeoAskItem => ({
  id: 'i1',
  text: 'PR merged into dev',
  state: 'met',
  evidence: 'merged',
  check: 'coding.pr_merged',
  metBy: 'daemon',
  removed: false,
  addedAt: 1,
  deliveredBy: 'a',
  watch,
  ...extra,
});
const pr = (url: string, state: NeoRefState['state'], base = 'dev'): NeoRefState => ({
  url,
  kind: 'pr',
  state,
  at: 1,
  done: state === 'MERGED',
  closedBy: null,
  base,
});

describe('readCodingPrerequisiteBase', () => {
  const readers = (states: NeoRefState[], commits: Record<string, string | null>) => ({
    readRefStates: async (refs: readonly { number: number }[]) =>
      states.filter((state) => refs.some((ref) => state.url.endsWith(`/${ref.number}`))),
    readMergeCommit: async (url: string) => commits[url] ?? null,
    cardBase: () => 'dev',
  });

  test("returns the merge commits of a prerequisite's merged pull request or closing pull requests", async () => {
    const prUrl = 'https://github.com/o/r/pull/7';
    expect(
      await readCodingPrerequisiteBase(
        [item([prUrl])],
        readers([pr(prUrl, 'MERGED')], { [prUrl]: merge })
      )
    ).toEqual({ ok: true, value: { prerequisiteCommits: [merge] } });
    const issue: NeoRefState = {
      url: 'https://github.com/o/r/issues/6',
      kind: 'issue',
      state: 'CLOSED',
      at: 1,
      done: true,
      closedBy: prUrl,
      merges: [
        { url: prUrl, base: 'dev' },
        { url: 'https://github.com/o/r/pull/8', base: 'release' },
      ],
    };
    expect(
      await readCodingPrerequisiteBase([item([issue.url])], readers([issue], { [prUrl]: merge }))
    ).toEqual({ ok: true, value: { prerequisiteCommits: [merge] } });
  });

  test('refuses a merge it cannot read or that landed on another base, and adds nothing without a merged-PR outcome', async () => {
    const prUrl = 'https://github.com/o/r/pull/7';
    expect(
      await readCodingPrerequisiteBase([item([prUrl])], readers([pr(prUrl, 'MERGED')], {}))
    ).toEqual({ ok: false, reason: `prerequisite_merge_unknown: ${prUrl}` });
    expect(
      await readCodingPrerequisiteBase([item([prUrl])], readers([pr(prUrl, 'OPEN')], {}))
    ).toEqual({ ok: false, reason: `prerequisite_not_merged: ${prUrl}` });
    expect(
      await readCodingPrerequisiteBase(
        [item([prUrl])],
        readers([pr(prUrl, 'MERGED', 'release')], { [prUrl]: merge })
      )
    ).toEqual({ ok: false, reason: `prerequisite_not_merged: ${prUrl}` });
    expect(await readCodingPrerequisiteBase([item([prUrl])], readers([], {}))).toEqual({
      ok: false,
      reason: 'prerequisite_ref_unreadable',
    });
    expect(
      await readCodingPrerequisiteBase([item([prUrl], { check: null })], readers([], {}))
    ).toEqual({ ok: true, value: {} });
    expect(
      await readCodingPrerequisiteBase([item(['https://example.com/not-github'])], readers([], {}))
    ).toEqual({ ok: false, reason: 'prerequisite_ref_unreadable' });
  });
});

describe('a dependent coding card start', () => {
  const target: NeoDriverTarget = {
    verb: 'start',
    adapter: 'codex-desktop',
    place: { machine: 'laptop', folder: '/focus/dolmen', name: 'dolmen', daemon: 'laptop' },
    preparationParameters: { target: 'dev' },
  };

  async function setup(base: Awaited<ReturnType<NonNullable<NeoPack['prerequisiteParameters']>>>) {
    const db = await createTestDb();
    db.createSession(createTestSession('neo:root'));
    const prepared: unknown[] = [];
    const registry = createOperationRegistry(
      ['work.start', 'work.stop'].map((name) =>
        defineOperation({
          name,
          description: name,
          inputSchema: z.record(z.string(), z.unknown()),
          resultSchema: z.unknown(),
          execute: async (input) => {
            if (name === 'work.stop') return { ok: true, value: { stopped: true } };
            prepared.push(input.preparation);
            return {
              ok: true,
              value: { ref: { adapter: 'codex-desktop', id: `t${prepared.length}` } },
            };
          },
        })
      )
    );
    const service = new NeoService(
      db,
      { getOperationRegistry: () => registry } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
    Object.assign(service, { returnReport: async () => {}, deliver: async () => {} });
    const read = mock(async () => base);
    service.filePacks = [
      {
        id: 'fixture',
        describe: 'fixture',
        instructions: () => null,
        prepareExecution: async () => ({ ok: false, reason: 'unused' }),
        prerequisiteParameters: read,
      } as unknown as NeoPack,
    ];
    service.repo.reserveBinding({ sessionId: 'neo:root', kind: 'neo', projectId: null });
    for (const id of ['a', 'b']) {
      service.driverTargets.propose(
        service.repo,
        {
          id,
          requestKey: `neo:root:${id}`,
          projectId: null,
          originSessionId: 'neo:root',
          originMessageId: `m-${id}`,
          title: `Card ${id}`,
          instruction: `Do ${id}.`,
        },
        target
      );
      service.askRecords.open(
        {
          id: `ask-${id}`,
          requestKey: `ask-${id}`,
          projectId: null,
          originSessionId: 'neo:root',
          originMessageId: `m-${id}`,
          title: id,
          ask: id,
          doneWhen: id,
          doneSource: 'human',
          pack: 'fixture',
        },
        [{ text: `Outcome ${id}`, check: null, deliveredBy: id }]
      );
    }
    const start = (id: string, dependsOn?: string[]) =>
      invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.work.start',
        { id, ...(dependsOn ? { dependsOn } : {}) },
        { source: 'rpc', principal: 'local' }
      );
    await start('b', ['a']);
    await start('a');
    const outcome = service.askRecords.get('ask-a')!.doneItems![0];
    service.askRecords.tickItem(
      'ask-a',
      { ...outcome, state: 'met', evidence: 'The human answered: merged', metBy: 'human' },
      Date.now(),
      outcome,
      true
    );
    return { db, service, prepared, read, start };
  }

  test("prepares the dependent's base from its prerequisite's merge commits", async () => {
    const { db, prepared, read, start } = await setup({
      ok: true,
      value: { prerequisiteCommits: [merge] },
    });
    try {
      prepared.length = 0;
      expect(await start('b')).toMatchObject({ value: { ok: true } });
      expect(read).toHaveBeenLastCalledWith([expect.objectContaining({ deliveredBy: 'a' })]);
      expect(prepared).toEqual([
        { pack: 'fixture', parameters: { target: 'dev', prerequisiteCommits: [merge] } },
      ]);
    } finally {
      db.close();
    }
  });

  test('keeps a dependent waiting, not failed, and retries later while its prerequisite merge cannot be read', async () => {
    const { db, service, prepared, start } = await setup({
      ok: false,
      reason: 'prerequisite_merge_unknown: https://github.com/o/r/pull/7',
    });
    try {
      db.getDatabase().prepare("DELETE FROM job_queue WHERE queue = 'neo.work.admission'").run();
      prepared.length = 0;
      await start('b');
      expect(prepared).toEqual([]);
      expect(service.repo.getWork('b')?.status).toBe('proposed');
      expect(service.driverTargets.readCard('b')?.claimedAt).toBeNull();
      const retry = db
        .getDatabase()
        .prepare(
          "SELECT run_at AS runAt FROM job_queue WHERE queue = 'neo.work.admission' AND status = 'pending' AND json_extract(payload, '$.workId') = 'b'"
        )
        .get() as { runAt: number } | null;
      expect(retry?.runAt).toBeGreaterThan(Date.now() + 60_000);
    } finally {
      db.close();
    }
  });
});
