import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCopilotAdapter } from '../../../../src/lib/drivers/copilot-adapter';
import type { StartRequest, WorkCallContext } from '../../../../src/lib/drivers/types';

const runs: string[] = [];
const owners: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.close();
  for (const run of runs.splice(0)) rmSync(run, { recursive: true, force: true });
});
const context = { from: 'chat', caller: { source: 'rpc' } } as WorkCallContext;
function setup(flag = '') {
  const run = mkdtempSync(join(tmpdir(), 'copilot-adapter-'));
  runs.push(run);
  mkdirSync(join(run, 'home'));
  const cliPath = join(run, 'copilot');
  const fixture = fileURLToPath(new URL('../../../fixtures/copilot-sdk.ts', import.meta.url));
  writeFileSync(
    cliPath,
    `#!/usr/bin/env bun\nprocess.argv.push('--production-version', ${JSON.stringify(flag)}); await import(${JSON.stringify(fixture)});\n`,
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
    makeFolder: (path: string) => mkdirSync(path),
  };
  const discovery = { id: 'copilot-cli', capabilities: ['find'] as const, find: () => [] };
  const adapter = createCopilotAdapter(discovery, deps);
  owners.push(adapter);
  const request: StartRequest = {
    place: { machine: 'test', folder: run, name: 'fixture' },
    title: 'Synthetic work',
    message: 'hold',
    model: 'synthetic-model',
  };
  return { run, deps, discovery, adapter, request };
}
async function start(fixture: ReturnType<typeof setup>, message = fixture.request.message) {
  const result = await fixture.adapter.start!({ ...fixture.request, message }, context);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return result.value;
}

describe('owned Copilot lifecycle', () => {
  test('start returns a receipt; status uses its actual reply and owned execution directory', async () => {
    const fixture = setup();
    expect(fixture.adapter.capabilities).toEqual(['find', 'start', 'status', 'stop']);
    const work = await start(fixture, 'settled');
    const detail = await fixture.adapter.status!(work.ref, undefined, work.receipt);
    expect(detail).toMatchObject({
      ok: true,
      value: {
        status: 'done',
        title: 'Synthetic work',
        model: 'synthetic-model',
        execution: { directory: fixture.run },
        inputEvidence: { state: 'observed', replyReport: 'REPLY_1', replyAvailability: 'complete' },
      },
    });
    expect(work.link).toBeUndefined();
    expect(work.watchHint).toContain('work.status');
    const calls = readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8');
    expect(calls).toContain('"availableTools":[]');
    expect(calls).toContain('"mode":"enqueue"');
  });

  test('permission denial stays needs_you with incomplete evidence', async () => {
    const fixture = setup();
    const work = await start(fixture, 'permission');
    expect(await fixture.adapter.status!(work.ref, undefined, work.receipt)).toMatchObject({
      ok: true,
      value: { status: 'needs_you', inputEvidence: { replyAvailability: 'incomplete' } },
    });
  });

  test('stop waits for abort evidence, closes the owned runtime, and remains stopped', async () => {
    const fixture = setup('--idle-after-abort');
    const work = await start(fixture);
    expect(await fixture.adapter.stop!(work.ref, context)).toEqual({
      ok: true,
      value: { stopped: true },
    });
    expect(await fixture.adapter.status!(work.ref)).toMatchObject({
      ok: true,
      value: { status: 'stopped' },
    });
    const calls = readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.method === 'session.abort')).toHaveLength(1);
    expect(() => process.kill(calls[0].pid, 0)).toThrow();
    expect(
      await fixture.adapter.stop!({ adapter: 'copilot-cli', id: crypto.randomUUID() }, context)
    ).toMatchObject({ ok: false, reason: 'not_found' });
  });

  test('an abort ACK alone cannot report stopped, but closes its owned process', async () => {
    const fixture = setup('--abort-ack-only');
    const work = await start(fixture);
    expect(await fixture.adapter.stop!(work.ref, context)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    expect(await fixture.adapter.status!(work.ref)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
  });

  test('restart retains ownership identity without replaying or taking external sessions', async () => {
    const fixture = setup();
    const work = await start(fixture);
    await fixture.adapter.close();
    const restarted = createCopilotAdapter(fixture.discovery, fixture.deps);
    owners.push(restarted);
    expect(await restarted.status!(work.ref, undefined, work.receipt)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    expect(await restarted.stop!(work.ref, context)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    expect(
      await restarted.status!({ adapter: 'copilot-cli', id: crypto.randomUUID() })
    ).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await restarted.status!({ adapter: 'copilot-cli', id: '../escape' })).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
    expect(
      readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8').match(/"method":"session.send"/g)
    ).toHaveLength(1);
  });

  test('foreign receipts never get an unrelated reply', async () => {
    const fixture = setup();
    const work = await start(fixture, 'settled');
    const unknown = await fixture.adapter.status!(work.ref, undefined, {
      executionId: 'foreign',
      inputId: work.receipt!.inputId,
    });
    expect(unknown).toMatchObject({ ok: false, reason: 'not_found' });
  });

  test.each([
    ['effort', { effort: 'high' }, 'unsupported_effort'],
    ['missing model', { model: undefined }, 'unsupported_model'],
    ['unknown model', { model: 'unknown' }, 'unreachable'],
    [
      'remote folder',
      { place: { machine: 'elsewhere', folder: '/', name: 'remote' } },
      'invalid_place',
    ],
    [
      'unregistered preparation',
      { preparation: { pack: 'unknown', parameters: {} } },
      'unsupported_preparation',
    ],
  ] as const)('refuses %s without sending', async (_label, patch, reason) => {
    const fixture = setup();
    expect(await fixture.adapter.start!({ ...fixture.request, ...patch }, context)).toMatchObject({
      ok: false,
      reason,
    });
    expect(
      existsSync(join(fixture.run, 'calls.jsonl'))
        ? readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8')
        : ''
    ).not.toContain('session.send');
  });

  test('a lost first ACK preserves identity and refuses automatic replay', async () => {
    const fixture = setup();
    const failure = await fixture.adapter.start!(
      { ...fixture.request, message: 'lost-ack' },
      context
    );
    expect(failure).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(JSON.stringify(failure)).toMatch(/copilot-cli:[0-9a-f-]{36}/);
    expect(
      readFileSync(join(fixture.run, 'calls.jsonl'), 'utf8').match(/"method":"session.send"/g)
    ).toHaveLength(1);
  });
});
