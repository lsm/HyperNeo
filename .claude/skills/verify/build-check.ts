import { strict as assert } from 'node:assert';
import { request } from 'node:http';
import { join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { OPERATION_NAMES } from '../../../packages/shared/src/types/operation-names.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const socketPath = join(run, 'data/session-door.sock');
assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
const keys = ['commit', 'health', 'pid', 'startedAt', 'uptime', 'version'];
const daemonPid = Number(await Bun.file(join(run, 'daemon.pid')).text());
const expectedCommit = process.argv[3];
assert.match(expectedCommit, /^[a-f0-9]{40}$/);
const post = (name: string, sender: string | undefined = 'verify-build') =>
  new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const call = request({ socketPath, path: '/', method: 'POST' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode!, body: JSON.parse(Buffer.concat(chunks).toString()) }));
    });
    call.on('error', reject);
    call.end(JSON.stringify({ sender, name, input: {} }));
  });
const outputs: Record<string, unknown> = {};
for (const entry of ['main.ts', 'prod-entry.ts']) {
  if (entry === 'main.ts') {
    const help = Bun.spawn([process.execPath, `packages/cli/${entry}`, '--help'], {
      env: process.env, stdout: 'pipe', stderr: 'pipe',
    });
    const helpText = await new Response(help.stdout).text();
    const helpError = await new Response(help.stderr).text();
    assert.equal(await help.exited, 0, helpError);
    assert(helpText.includes('hyperneo build'), `${entry} help must list build`);
    outputs[`${entry}:help`] = helpText;
  }
  const child = Bun.spawn([process.execPath, `packages/cli/${entry}`, 'build'], {
    env: { ...process.env, HYPERNEO_SESSION_ID: 'verify-build', HYPERNEO_SESSION_DOOR: socketPath },
    stdout: 'pipe', stderr: 'pipe',
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  assert.equal(await child.exited, 0, stderr);
  const value = JSON.parse(stdout);
  assert.deepEqual(Object.keys(value).sort(), keys);
  assert.equal(value.commit, expectedCommit);
  assert.equal(value.pid, daemonPid);
  assert.equal(value.health, 'ok');
  assert.equal(typeof value.version, 'string');
  assert(value.startedAt > 0 && value.startedAt <= Date.now());
  assert(value.uptime >= 0);
  outputs[entry] = value;
}
const first = outputs['main.ts'] as { startedAt: number; uptime: number };
const second = outputs['prod-entry.ts'] as typeof first;
assert.equal(first.startedAt, second.startedAt);
assert(second.uptime >= first.uptime);
const allowed = new Set(['message.send', 'neo.question.get', 'system.build']);
const denied: string[] = [];
for (const name of [...OPERATION_NAMES, 'system.health', 'unknown.operation']) {
  if (allowed.has(name)) continue;
  const reply = await post(name);
  assert.equal(reply.status, 400, name);
  assert.match(String(reply.body.error), /^not_allowed/, name);
  denied.push(name);
}
const noSender = await post('system.build', '');
assert.equal(noSender.status, 400);
assert.match(String(noSender.body.error), /^no_sender/);
await Bun.write(join(run, 'evidence/build-check.json'), JSON.stringify({ outputs, denied, noSender, socketMode: '0600' }, null, 2));
console.log(`PASS: both CLI entry points returned exactly six fields for daemon PID ${daemonPid}; ${denied.length} other operations denied; missing sender denied; socket mode 0600.`);
