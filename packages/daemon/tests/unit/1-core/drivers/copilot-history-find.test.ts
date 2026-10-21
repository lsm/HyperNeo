import { afterEach, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCopilotAdapter } from '../../../../src/lib/drivers/copilot-adapter';
import { createAcpAgentAdapter } from '../../../../src/lib/drivers/acp-agent-adapter';
import type { WorkTurnPage } from '../../../../src/storage/work-turn-page';
import type { WorkAdapter, WorkCallContext, WorkStarted } from '../../../../src/lib/drivers/types';

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
function setup() {
  const run = mkdtempSync(join(tmpdir(), 'copilot-history-'));
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
    listSessions: async () => external,
    ownSessions: () => new Set(),
    projectFolder: () => run,
  });
  const deps = {
    cliPath,
    directory: join(run, 'owned'),
    machine: 'test',
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
});
