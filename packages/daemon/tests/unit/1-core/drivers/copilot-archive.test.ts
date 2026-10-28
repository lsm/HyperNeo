import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCopilotAdapter } from '../../../../src/lib/drivers/copilot-adapter';
import type { WorkCallContext, WorkStarted } from '../../../../src/lib/drivers/types';

const context = { from: 'chat', caller: { source: 'rpc' } } as WorkCallContext;
const runs: { run: string; close: () => Promise<void> }[] = [];
function setup() {
  const run = mkdtempSync(join(tmpdir(), 'copilot-archive-'));
  mkdirSync(join(run, 'home'));
  const source = fileURLToPath(new URL('../../../fixtures/copilot-sdk.ts', import.meta.url));
  const cliPath = join(run, 'copilot');
  writeFileSync(
    cliPath,
    `#!/usr/bin/env bun\nprocess.argv.push('--production-version', '--durable-inputs'); await import(${JSON.stringify(source)});\n`,
    { mode: 0o700 }
  );
  const deps = {
    cliPath,
    directory: join(run, 'owned'),
    machine: 'test',
    homeDir: join(run, 'home'),
    env: { HOME: join(run, 'home'), PATH: process.env.PATH ?? '' },
    timeoutMs: 1500,
    folderExists: existsSync,
    makeFolder: (folder: string) => mkdirSync(folder),
  };
  const discovery = { id: 'copilot-cli', capabilities: ['find'] as const, find: () => [] };
  let adapter = createCopilotAdapter(discovery, deps);
  runs.push({ run, close: () => adapter.close() });
  const calls = (): { method: string }[] =>
    readFileSync(join(run, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  return {
    run,
    calls,
    get adapter() {
      return adapter;
    },
    async restart() {
      await adapter.close();
      adapter = createCopilotAdapter(discovery, deps);
    },
    async start(message: string) {
      const result = await adapter.start!(
        {
          place: { machine: 'test', folder: run, name: 'fixture' },
          title: 'Archive',
          model: 'synthetic-model',
          message,
        },
        context
      );
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.value;
    },
    archive: (work: WorkStarted, admit = () => null) => adapter.archive!(work.ref, admit),
    find: (includeClosed: boolean) => adapter.find({ includeClosed, limit: 20 }),
  };
}
afterEach(async () => {
  for (const { run, close } of runs.splice(0)) {
    await close();
    rmSync(run, { recursive: true, force: true });
  }
});
async function settled(f: ReturnType<typeof setup>, work: WorkStarted) {
  for (let poll = 0; poll < 200; poll++) {
    const result = await f.adapter.status!(work.ref);
    if (result.ok && result.value.status === 'done') return;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error('no terminal evidence');
}

describe('Copilot owned archive', () => {
  test('archives settled owned work in HyperNeo only, hides it from open work and refuses input', async () => {
    const f = setup();
    expect(f.adapter.capabilities).toContain('archive');
    const work = await f.start('settled');
    await settled(f, work);
    const before = f.calls().length;
    expect(await f.archive(work)).toEqual({ ok: true, value: { archived: true } });
    expect(await f.archive(work)).toEqual({ ok: true, value: { archived: false } });
    expect((await f.find(false)).flatMap((group) => group.work)).toEqual([]);
    const [group] = await f.find(true);
    expect(group).toMatchObject({ openCount: 0, archivedCount: 1 });
    expect(group.work).toMatchObject([{ ref: work.ref, status: 'stopped' }]);
    expect(await f.adapter.send!(work.ref, 'settled', context)).toMatchObject({
      ok: false,
      reason: 'not_open',
    });
    expect(f.calls()).toHaveLength(before);
    await f.restart();
    expect(await f.adapter.status!(work.ref)).toMatchObject({
      ok: true,
      value: { status: 'done' },
    });
    expect(existsSync(join(f.run, 'owned', work.ref.id, 'session-state', work.ref.id))).toBe(true);
  });

  test('refuses live running work before asking for admission', async () => {
    const f = setup();
    const work = await f.start('hold');
    let admitted = 0;
    expect(
      await f.archive(work, () => {
        admitted++;
        return null;
      })
    ).toMatchObject({ ok: false, reason: 'busy' });
    expect(admitted).toBe(0);
  });

  test('returns the admission refusal and leaves orphaned work open', async () => {
    const f = setup();
    const work = await f.start('hold');
    await f.restart();
    const refusal = { ok: false as const, reason: 'human_only' as const, detail: 'Ask the human.' };
    expect(await f.archive(work, () => refusal)).toEqual(refusal);
    expect((await f.find(false)).flatMap((group) => group.work)).toHaveLength(1);
    expect(await f.archive(work)).toEqual({ ok: true, value: { archived: true } });
  });
});
