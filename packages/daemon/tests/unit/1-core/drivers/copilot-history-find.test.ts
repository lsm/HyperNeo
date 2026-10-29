import { testDirectories } from '../../../helpers/temporary-directory';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCopilotAdapter } from '../../../../src/lib/drivers/copilot-adapter';
import { createAcpAgentAdapter } from '../../../../src/lib/drivers/acp-agent-adapter';
import type { WorkTurnPage } from '../../../../src/storage/work-turn-page';
import type { WorkAdapter, WorkCallContext, WorkStarted } from '../../../../src/lib/drivers/types';

const createTestDirectory = testDirectories();

type Readable = WorkAdapter & {
  readTurns?: (
    id: string,
    around: string | undefined,
    before: number,
    after: number,
    cursor?: WorkTurnPage['nextCursor']
  ) => WorkTurnPage | null;
};
const fixtures: ReturnType<typeof setup>[] = [];
const context = { from: 'chat', caller: { source: 'rpc' } } as WorkCallContext;
const query = { includeClosed: true, limit: 20 };
function setup(projectFolder?: string) {
  const run = realpathSync(createTestDirectory(join(tmpdir(), 'copilot-history-')));
  mkdirSync(join(run, 'home'));
  const cliPath = join(run, 'copilot');
  const source = fileURLToPath(new URL('../../../fixtures/copilot-sdk.ts', import.meta.url));
  writeFileSync(
    cliPath,
    `#!/usr/bin/env bun\nprocess.argv.push('--production-version', '--durable-inputs'); await import(${JSON.stringify(source)});\n`,
    { mode: 0o700 }
  );
  const external = [
    { sessionId: 'external', cwd: '/synthetic/copilot-project', title: 'External', updatedAt: 1 },
  ];
  const discovery = createAcpAgentAdapter({
    agent: { id: 'copilot-cli', name: 'Copilot', bin: 'copilot', args: [] },
    machine: 'test',
    now: Date.now,
    listSessions: async () => {
      if (existsSync(join(run, 'acp-list-failure')))
        throw new Error('Synthetic ACP listing failure');
      return external;
    },
    ownSessions: () => new Set(),
    projectFolder: () => projectFolder ?? run,
  });
  const deps = {
    cliPath,
    timeoutMs: 1500,
    directory: join(run, 'owned'),
    machine: 'test',
    projectFolder: () => projectFolder ?? run,
    env: { HOME: join(run, 'home'), PATH: process.env.PATH ?? '' },
    homeDir: join(run, 'home'),
    folderExists: existsSync,
    makeFolder: (p: string) => mkdirSync(p),
  };
  let adapter = createCopilotAdapter(discovery, deps);
  const f = {
    run,
    external,
    get adapter() {
      return adapter;
    },
    async restart() {
      await adapter.close();
      adapter = createCopilotAdapter(discovery, deps);
    },
    async start(message = 'history') {
      const result = await adapter.start!(
        {
          place: { machine: 'test', folder: run, name: 'Fixture' },
          title: 'Owned title',
          model: 'synthetic-model',
          message,
        },
        context
      );
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.value;
    },
    history(work: WorkStarted) {
      return join(run, 'owned', work.ref.id, 'session-state', work.ref.id, 'events.jsonl');
    },
    read(
      work: WorkStarted,
      around?: string,
      before = 2,
      after = 2,
      cursor?: WorkTurnPage['nextCursor']
    ) {
      return (adapter as Readable).readTurns?.(work.ref.id, around, before, after, cursor);
    },
  };
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.adapter.close();
});

describe('Copilot owned history and discovery', () => {
  test('reads user/tool/assistant text with stable IDs, deduplicates and survives restart without resume', async () => {
    const f = setup();
    const work = await f.start();
    const page = f.read(work, undefined, 10, 10);
    expect(page?.turns.map((t) => [t.role, t.text])).toEqual([
      ['user', 'history'],
      ['tool', 'synthetic {"path":"fixture.txt"}'],
      ['tool', 'SYNTHETIC_TOOL_RESULT'],
      ['assistant', 'HISTORY_REPLY'],
    ]);
    expect(new Set(page?.turns.map((t) => t.messageId)).size).toBe(4);
    await f.restart();
    expect(f.read(work, undefined, 10, 10)).toEqual(page);
    expect(readFileSync(join(f.run, 'calls.jsonl'), 'utf8')).not.toContain('session.resume');
    expect((f.adapter as Readable).readTurns?.('external', undefined, 2, 2)).toBeNull();
  });

  test('pages older bounded history, preserves IDs and refuses rotated or truncated cursors', async () => {
    const f = setup();
    const work = await f.start();
    const file = f.history(work);
    for (let n = 0; n < 30; n++)
      appendFileSync(
        file,
        JSON.stringify({
          type: 'assistant.message',
          data: { messageId: `long-${n}`, content: 'x'.repeat(5000) },
          timestamp: new Date().toISOString(),
        }) + '\n'
      );
    appendFileSync(file, '{"type":"assistant.message"');
    const first = f.read(work, undefined, 1, 1);
    expect(first?.turns).toHaveLength(3);
    expect(first?.turns[0].messageId).toBe('assistant:long-27');
    expect(first?.turns.every((t) => t.text.length <= 4000)).toBe(true);
    expect(first?.availability).toBe('incomplete');
    expect(first?.nextCursor).toBeDefined();
    const next = f.read(work, undefined, 1, 1, first?.nextCursor);
    expect(next?.turns.at(-1)?.messageId).toBe('assistant:long-26');
    expect(f.read(work, 'assistant:long-10', 1, 1)?.turns.map((t) => t.messageId)).toEqual([
      'assistant:long-9',
      'assistant:long-10',
      'assistant:long-11',
    ]);
    const original = readFileSync(file);
    writeFileSync(file, '{}\n');
    expect(f.read(work, undefined, 1, 1, first?.nextCursor)?.availability).toBe(
      'reply_unavailable'
    );
    writeFileSync(file, original);
    renameSync(file, file + '.preserved');
    writeFileSync(file, '{}\n');
    expect(f.read(work, undefined, 1, 1, first?.nextCursor)?.availability).toBe(
      'reply_unavailable'
    );
    expect(f.read(work, '../../not-a-message')?.availability).toBe('reply_unavailable');
  });

  test('owned status overrides both young and old ACP heuristics, dedupes before title filtering', async () => {
    const f = setup();
    const completed = await f.start();
    const blocked = await f.start('permission');
    f.external.push(
      {
        sessionId: completed.ref.id,
        cwd: '/synthetic/copilot-project',
        title: 'Wrong ACP title',
        updatedAt: Date.now(),
      },
      {
        sessionId: blocked.ref.id,
        cwd: '/synthetic/copilot-project',
        title: 'Wrong ACP title',
        updatedAt: 1,
      }
    );
    const groups = await f.adapter.find(query);
    const work = groups.flatMap((g) => g.work);
    expect(work.filter((w) => w.ref.id === completed.ref.id)).toMatchObject([
      { title: 'Owned title', status: 'done' },
    ]);
    expect(work.filter((w) => w.ref.id === blocked.ref.id)).toMatchObject([
      { status: 'needs_you' },
    ]);
    expect(work.find((w) => w.ref.id === 'external')?.status).toBe('done');
    expect((await f.adapter.find({ ...query, text: 'Wrong ACP' })).flatMap((g) => g.work)).toEqual(
      []
    );
    expect(
      (await f.adapter.find({ ...query, text: 'Owned title' })).flatMap((g) => g.work)
    ).toHaveLength(2);
    await f.restart();
    const orphan = (await f.adapter.find(query))
      .flatMap((g) => g.work)
      .find((w) => w.ref.id === blocked.ref.id);
    expect(orphan?.status).toBe('needs_you');
    expect(orphan?.watchHint).toContain('unavailable');
    expect(readFileSync(join(f.run, 'calls.jsonl'), 'utf8')).not.toContain('session.resume');
  });
  test('bounded byte pages handle UTF-8, malformed records and oversized lines without mutating history', async () => {
    const f = setup();
    const work = await f.start();
    const file = f.history(work);
    appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant.message',
        timestamp: new Date().toISOString(),
        data: { messageId: 'oversized', content: '界'.repeat(100000) },
      }) + '\n'
    );
    appendFileSync(
      file,
      'malformed\n' +
        JSON.stringify({
          type: 'unknown.fixture',
          timestamp: new Date().toISOString(),
          data: { content: 'DO_NOT_SHOW' },
        }) +
        '\n'
    );
    appendFileSync(
      file,
      JSON.stringify({
        type: 'assistant.message',
        timestamp: new Date().toISOString(),
        data: { messageId: 'tail', content: '尾部' },
      }) + '\n'
    );
    const original = readFileSync(file);
    const page = f.read(work, undefined, 1, 1);
    expect(page?.turns.map((t) => t.text)).toEqual(['尾部']);
    expect(page?.availability).toBe('incomplete');
    expect(page?.nextCursor).toBeDefined();
    expect(readFileSync(file)).toEqual(original);
    const detail = await f.adapter.status!(work.ref, undefined, work.receipt);
    expect(detail).toMatchObject({
      ok: true,
      value: {
        lastReply: 'HISTORY_REPLY',
        inputEvidence: { replyReport: 'HISTORY_REPLY', replyAvailability: 'complete' },
      },
    });
    renameSync(file, file + '.preserved');
    symlinkSync(file + '.preserved', file);
    expect(f.read(work)?.availability).toBe('reply_unavailable');
  });

  test('a clipped turn never ends in half of an emoji', async () => {
    const f = setup();
    const work = await f.start();
    appendFileSync(
      f.history(work),
      JSON.stringify({
        type: 'assistant.message',
        timestamp: new Date().toISOString(),
        data: { messageId: 'emoji-edge', content: `${'a'.repeat(3999)}😀 and more` },
      }) + '\n'
    );
    const [turn] = f.read(work, undefined, 0, 0)?.turns ?? [];
    expect(turn).toMatchObject({ text: 'a'.repeat(3999), textComplete: false });
  });

  test('find keeps grouped project and execution folder distinct and never completes uncertain accepted work', async () => {
    const f = setup('/synthetic/grouped-project');
    const work = await f.start();
    const path = join(f.run, 'owned', `${work.ref.id}.json`);
    await f.restart();
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.pendingSubmission = true;
    record.snapshot.status = 'unreachable';
    writeFileSync(path, JSON.stringify(record));
    const items = (
      await f.adapter.find({ ...query, folder: '/synthetic/grouped-project' })
    ).flatMap((g) => g.work);
    expect(items.find((w) => w.ref.id === work.ref.id)).toMatchObject({
      status: 'queued',
      place: { folder: '/synthetic/grouped-project' },
      watchHint: expect.stringContaining('unavailable'),
    });
    expect(await f.adapter.status!(work.ref)).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(await f.adapter.status!(work.ref, undefined, work.receipt)).toMatchObject({
      ok: true,
      value: { execution: { directory: f.run }, lastReply: 'HISTORY_REPLY' },
    });
    expect(await f.adapter.find({ ...query, spaceId: 'external-space' })).toEqual([]);
  });
  test('external title search happens before the 20-newest place window', async () => {
    const f = setup();
    for (let n = 0; n < 25; n++)
      f.external.push({
        sessionId: `new-${n}`,
        cwd: '/synthetic/copilot-project',
        title: `New item ${n}`,
        updatedAt: Date.now(),
      });
    f.external.push({
      sessionId: 'old-match',
      cwd: '/synthetic/copilot-project',
      title: 'Rare target',
      updatedAt: 1,
    });
    expect(
      (await f.adapter.find({ ...query, text: 'Rare target' }))
        .flatMap((g) => g.work)
        .map((w) => w.ref.id)
    ).toEqual(['old-match']);
  });

  test('find observes a live worker without pinging, writing its record or killing it', async () => {
    const f = setup();
    const work = await f.start('hold');
    const callsFile = join(f.run, 'calls.jsonl');
    const before = readFileSync(callsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const record = join(f.run, 'owned', `${work.ref.id}.json`);
    const original = readFileSync(record);
    writeFileSync(join(f.run, 'block-ping'), 'withhold ping reply');
    expect(
      (await f.adapter.find(query)).flatMap((g) => g.work).find((w) => w.ref.id === work.ref.id)
        ?.status
    ).toBe('running');
    const after = readFileSync(callsFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(after.filter((c) => c.method === 'ping')).toHaveLength(
      before.filter((c) => c.method === 'ping').length
    );
    expect(after.some((c) => c.method === 'runtime.shutdown')).toBe(false);
    expect(readFileSync(record)).toEqual(original);
    expect(() => process.kill(before[0].pid, 0)).not.toThrow();
    renameSync(join(f.run, 'block-ping'), join(f.run, 'block-ping.released'));
    const followup = await f.adapter.send!(work.ref, 'finish', context);
    expect(followup.ok).toBe(true);
    expect(await f.adapter.status!(work.ref, undefined, work.receipt)).toMatchObject({
      ok: true,
      value: { status: 'done', lastReply: 'FIRST_REPLY' },
    });
  });

  test('owned discovery remains available when a cold external list fails; failure without owned work stays explicit', async () => {
    const f = setup();
    writeFileSync(join(f.run, 'acp-list-failure'), 'fail');
    await expect(f.adapter.find(query)).rejects.toThrow('Synthetic ACP listing failure');
    const work = await f.start();
    await f.restart();
    const items = (await f.adapter.find(query)).flatMap((g) => g.work);
    expect(items).toMatchObject([{ ref: work.ref, status: 'done' }]);
    expect(items[0].watchHint).toContain('External Copilot discovery unavailable');
    expect(readFileSync(join(f.run, 'calls.jsonl'), 'utf8')).not.toContain('session.resume');
  });
  test.each(['unknown', 'delta', 'subagent', 'malformed'])(
    'paging over only %s records preserves the turn straddling the byte boundary',
    async (kind) => {
      const f = setup();
      const work = await f.start();
      const file = f.history(work);
      appendFileSync(
        file,
        JSON.stringify({
          type: 'assistant.message',
          timestamp: new Date().toISOString(),
          data: { messageId: 'boundary-turn', content: 'BOUNDARY'.repeat(600) },
        }) + '\n'
      );
      const boundary = Buffer.byteLength(readFileSync(file));
      const hidden = {
        type:
          kind === 'subagent'
            ? 'assistant.message'
            : kind === 'delta'
              ? 'assistant.message_delta'
              : 'unknown.fixture',
        timestamp: new Date().toISOString(),
        data: { messageId: 'hidden', content: 'not visible' },
        ...(kind === 'subagent' ? { agentId: 'child' } : {}),
        padding: '',
      };
      hidden.padding = 'x'.repeat(262000 - Buffer.byteLength(JSON.stringify(hidden) + '\n'));
      appendFileSync(
        file,
        kind === 'malformed' ? '!'.repeat(261999) + '\n' : JSON.stringify(hidden) + '\n'
      );
      const first = f.read(work, undefined, 10, 10);
      expect(first?.turns).toEqual([]);
      expect(first?.nextCursor?.before).toBe(boundary);
      const second = f.read(work, undefined, 10, 10, first?.nextCursor);
      expect(second?.turns.find((t) => t.messageId === 'assistant:boundary-turn')).toMatchObject({
        text: 'BOUNDARY'.repeat(600).slice(0, 4000),
        textComplete: false,
      });
    }
  );

  test('empty windows over an oversized line always move the cursor backwards', async () => {
    const f = setup();
    const work = await f.start();
    const file = f.history(work);
    appendFileSync(
      file,
      JSON.stringify({
        type: 'unknown.fixture',
        timestamp: new Date().toISOString(),
        data: {},
        padding: 'x'.repeat(600000),
      }) + '\n'
    );
    let cursor: WorkTurnPage['nextCursor'];
    let previous = readFileSync(file).length + 1;
    const ids: string[] = [];
    for (let n = 0; n < 10; n++) {
      const page = f.read(work, undefined, 10, 10, cursor);
      expect(page).toBeDefined();
      ids.push(...page!.turns.map((t) => t.messageId));
      cursor = page?.nextCursor;
      if (!cursor) break;
      expect(cursor.before).toBeLessThan(previous);
      previous = cursor.before;
    }
    expect(cursor).toBeUndefined();
    expect(ids).toContain('assistant:reply-1');
  });
});
