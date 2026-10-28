import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCopilotAdapter } from '../../../../src/lib/drivers/copilot-adapter';
import type { WorkCallContext, WorkStarted } from '../../../../src/lib/drivers/types';

const context = { from: 'chat', caller: { source: 'rpc' } } as WorkCallContext;
const fixtures: ReturnType<typeof setup>[] = [];
function setup() {
  const run = mkdtempSync(join(tmpdir(), 'copilot-rename-'));
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
  const calls = (): { method: string; params?: unknown }[] =>
    readFileSync(join(run, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
  const f = {
    run,
    get adapter() {
      return adapter;
    },
    calls,
    names: () => calls().filter((call) => call.method === 'session.name.set'),
    async restart() {
      await adapter.close();
      adapter = createCopilotAdapter(discovery, deps);
    },
    async start(message: string) {
      const result = await adapter.start!(
        {
          place: { machine: 'test', folder: run, name: 'fixture' },
          title: 'Original',
          model: 'synthetic-model',
          message,
        },
        context
      );
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.value;
    },
    rename: (work: WorkStarted, title: string) => adapter.rename!(work.ref, title, context),
  };
  fixtures.push(f);
  return f;
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.adapter.close();
    rmSync(f.run, { recursive: true, force: true });
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

describe('Copilot owned rename', () => {
  test('names a live owned session through session.name.set and keeps the title', async () => {
    const f = setup();
    expect(f.adapter.capabilities).toContain('rename');
    const work = await f.start('hold');
    expect(await f.rename(work, 'Copilot backend')).toEqual({
      ok: true,
      value: { renamed: true, title: 'Copilot backend' },
    });
    expect(f.names().map((call) => call.params)).toEqual([
      { sessionId: work.ref.id, name: 'Copilot backend' },
    ]);
    expect(await f.adapter.status!(work.ref)).toMatchObject({
      ok: true,
      value: { title: 'Copilot backend', status: 'running' },
    });
    await f.restart();
    expect(await f.adapter.status!(work.ref)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    const owned = JSON.parse(readFileSync(join(f.run, 'owned', `${work.ref.id}.json`), 'utf8'));
    expect(owned.work.title).toBe('Copilot backend');
  });

  test('resumes settled work to rename it, then releases the runtime', async () => {
    const f = setup();
    const work = await f.start('settled');
    await settled(f, work);
    await f.restart();
    expect(await f.rename(work, 'Settled matter')).toMatchObject({ ok: true });
    const calls = f.calls();
    expect(calls.filter((call) => call.method === 'session.resume')).toHaveLength(1);
    expect(f.names()).toHaveLength(1);
    expect(calls.filter((call) => call.method === 'session.send')).toHaveLength(1);
    expect(calls.at(-1)?.method).toBe('runtime.shutdown');
    expect(await f.adapter.status!(work.ref)).toMatchObject({
      ok: true,
      value: { title: 'Settled matter', status: 'done' },
    });
  });

  test('refuses names Copilot cannot hold and work it cannot reach without a name call', async () => {
    const f = setup();
    const work = await f.start('hold');
    expect(await f.rename(work, 'x'.repeat(101))).toMatchObject({
      ok: false,
      reason: 'not_delivered',
      notSent: true,
    });
    expect(
      await f.rename({ ...work, ref: { adapter: 'copilot-cli', id: crypto.randomUUID() } }, 'Other')
    ).toMatchObject({ ok: false, reason: 'not_found' });
    await f.restart();
    expect(await f.rename(work, 'Orphan')).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(f.names()).toHaveLength(0);
    const owned = JSON.parse(readFileSync(join(f.run, 'owned', `${work.ref.id}.json`), 'utf8'));
    expect(owned.work.title).toBe('Original');
  });

  test('refuses a rename while start is still writing its record', async () => {
    const f = setup();
    const starting = f.start('held-ack');
    let id: string | undefined;
    for (let poll = 0; poll < 400 && !id; poll++) {
      const found = (await f.adapter.find({ includeClosed: true, limit: 20 })).flatMap(
        (group) => group.work
      );
      id = found[0]?.ref.id;
      if (!id) await new Promise((done) => setTimeout(done, 5));
    }
    expect(
      await f.adapter.rename!({ adapter: 'copilot-cli', id: id! }, 'Raced', context)
    ).toMatchObject({ ok: false, reason: 'busy', notSent: true });
    writeFileSync(join(f.run, 'release-ack'), 'release');
    const work = await starting;
    expect(f.names()).toHaveLength(0);
    const owned = JSON.parse(readFileSync(join(f.run, 'owned', `${work.ref.id}.json`), 'utf8'));
    expect(owned.work).toMatchObject({ title: 'Original', receipt: work.receipt });
  });
});
