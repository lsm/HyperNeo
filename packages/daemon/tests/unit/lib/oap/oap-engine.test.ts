import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OapEngine, OapEngineOptions } from '../../../../src/lib/oap/oap-engine';
import type { OapHubClient } from '../../../../src/lib/oap/oap-hub-client';
import type { OapQueryHub } from '../../../../src/lib/oap/oap-query';

const roots: string[] = [];
const engines: OapEngine[] = [];

async function fixture(replaceAfterCheck = false) {
  const { OapEngine } = await import('../../../../src/lib/oap/oap-engine');
  const root = await mkdtemp(join(tmpdir(), 'oap-engine-'));
  roots.push(root);
  const binaryPath = join(root, 'synthetic-hub');
  const calls = join(root, 'calls');
  const replacement = `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(join(root, 'unverified-executed'))}, 'bad');\nprocess.exit(13);\n`;
  const script = `#!${process.execPath}
const fs = require('node:fs');
const calls = ${JSON.stringify(calls)};
if (process.argv[2] === '--version') { if (${replaceAfterCheck}) fs.writeFileSync(${JSON.stringify(binaryPath)}, ${JSON.stringify(replacement)}); console.log('synthetic-1'); process.exit(0); }
fs.appendFileSync(calls, 'start\\n');
fs.writeFileSync(${JSON.stringify(join(root, 'launch.json'))}, JSON.stringify({args:process.argv.slice(2),env:process.env}));
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(calls, request.op + '\\n');
  if (request.op === 'crash') process.exit(7);
  process.stdout.write(JSON.stringify({id:request.id,ok:true,result:process.pid}) + '\\n');
});
`;
  await writeFile(binaryPath, script);
  await chmod(binaryPath, 0o700);
  const options: OapEngineOptions = {
    binaryPath,
    identity: { version: 'synthetic-1', sha256: createHash('sha256').update(script).digest('hex') },
    stateDirectory: join(root, 'state'),
    hub: {
      adapters: { 'anthropic-codex': { type: 'codex', executable: join(root, 'codex') } },
      environment: { HOME: join(root, 'home'), CODEX_HOME: join(root, 'codex-home') },
    },
  };
  const engine = new OapEngine();
  engines.push(engine);
  const read =
    (value: typeof options = options) =>
    async () =>
      value;
  return { root, calls, options, engine, read };
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OapEngine', () => {
  test('creates independent query transports without launching the hub', async () => {
    const { engine, calls } = await fixture();
    const createQueryHub = (
      engine as unknown as { createQueryHub(client: OapHubClient): OapQueryHub }
    ).createQueryHub;
    const client = {} as OapHubClient;
    const first = createQueryHub.call(engine, client);
    const second = createQueryHub.call(engine, client);
    expect(first).not.toBe(second);
    expect(first.submit).toBeInstanceOf(Function);
    expect(existsSync(calls)).toBe(false);
  });

  test('starts one validated hub lazily for concurrent callers and stops it on close', async () => {
    const { engine, options, calls, root, read } = await fixture();
    expect(existsSync(calls)).toBe(false);
    const [first, second] = await Promise.all([engine.getHub(read()), engine.getHub(read())]);
    expect(first).toBe(second);
    const pid = (await first.request('ping')) as number;
    expect(await readFile(calls, 'utf8')).toBe('start\nping\n');
    const launch = JSON.parse(await readFile(join(root, 'launch.json'), 'utf8'));
    expect(launch.args).toEqual([
      'serve',
      '--stdio',
      '--config',
      join(root, 'state', 'oap-serve.json'),
      '--session-history',
      join(root, 'state', 'session-history.jsonl'),
    ]);
    delete launch.env.__CF_USER_TEXT_ENCODING;
    expect(launch.env).toEqual(options.hub.environment);
    expect(JSON.parse(await readFile(join(root, 'state', 'oap-serve.json'), 'utf8'))).toEqual({
      adapters: options.hub.adapters,
    });
    await engine.close();
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(engine.getHub(read())).rejects.toThrow('closed');
  });

  test('starts verified bytes when the installed path is replaced during version checking', async () => {
    const { engine, options, root, read } = await fixture(true);
    const outcome = await engine
      .getHub(read())
      .then((hub) => hub.request('ping'))
      .catch(() => false);
    expect(typeof outcome).toBe('number');
    expect(existsSync(join(root, 'unverified-executed'))).toBe(false);
    expect(await readFile(options.binaryPath, 'utf8')).toContain('unverified-executed');
    await engine.close();
    expect(await readdir(options.stateDirectory)).toEqual(['oap-serve.json']);
  });

  test('removes a stale snapshot from a hard crash before starting a fresh hub', async () => {
    const { engine, options, read } = await fixture();
    const stale = join(options.stateDirectory, 'oap-verified-x');
    await mkdir(stale, { recursive: true });
    await writeFile(join(stale, 'old-binary'), 'stale bytes');
    await writeFile(join(options.stateDirectory, 'unrelated'), 'keep');
    const hub = await engine.getHub(read());
    expect(existsSync(stale)).toBe(false);
    expect(typeof (await hub.request('ping'))).toBe('number');
    expect(await readFile(join(options.stateDirectory, 'unrelated'), 'utf8')).toBe('keep');
    await engine.close();
    expect((await readdir(options.stateDirectory)).sort()).toEqual(['oap-serve.json', 'unrelated']);
  });

  test('rejects a mismatched binary before starting or writing configuration', async () => {
    const { engine, options, calls, read } = await fixture();
    await expect(
      engine.getHub(read({ ...options, identity: { ...options.identity, sha256: '0'.repeat(64) } }))
    ).rejects.toThrow('sha256_mismatch');
    expect(existsSync(calls)).toBe(false);
    expect(existsSync(join(options.stateDirectory, 'oap-serve.json'))).toBe(false);
  });

  test('removes its verified copy when configuration cannot be written', async () => {
    const { engine, options, read } = await fixture();
    await mkdir(join(options.stateDirectory, 'oap-serve.json'), { recursive: true });
    await expect(engine.getHub(read())).rejects.toThrow();
    expect(await readdir(options.stateDirectory)).toEqual(['oap-serve.json']);
  });

  test('rejects an incomplete expected binary identity', async () => {
    const { engine, options, read } = await fixture();
    await expect(
      engine.getHub(
        read({ ...options, identity: { version: '', sha256: options.identity.sha256 } })
      )
    ).rejects.toThrow('invalid OAP binary identity');
    await expect(
      engine.getHub(
        read({ ...options, identity: { version: 'synthetic-1', sha256: 'not-a-sha256' } })
      )
    ).rejects.toThrow('invalid OAP binary identity');
  });

  test('does not resend the failed request when a crashed hub is restarted on later use', async () => {
    const { engine, options, calls, read } = await fixture();
    const first = await engine.getHub(read());
    expect(engine.isCurrentHub(first)).toBe(true);
    await expect(first.request('crash')).rejects.toThrow('code=7');
    expect(engine.isCurrentHub(first)).toBe(false);
    const second = await engine.getHub(read());
    expect(second).not.toBe(first);
    expect(engine.isCurrentHub(first)).toBe(false);
    expect(engine.isCurrentHub(second)).toBe(true);
    await second.request('ping');
    expect(await readFile(calls, 'utf8')).toBe('start\ncrash\nstart\nping\n');
    await engine.close();
    expect(engine.isCurrentHub(second)).toBe(false);
  });

  test('reuses the running hub for unchanged settings and restarts it when they change', async () => {
    const { engine, options, calls, root, read } = await fixture();
    const first = await engine.getHub(read());
    await first.request('ping');
    expect(await engine.getHub(read())).toBe(first);
    const changed = {
      ...options,
      hub: {
        adapters: { 'second-codex': { type: 'codex', executable: join(root, 'codex-2') } },
        environment: { HOME: join(root, 'home') },
      },
    };
    const second = await engine.getHub(read(changed));
    expect(second).not.toBe(first);
    expect(engine.isCurrentHub(first)).toBe(false);
    await second.request('ping');
    expect(JSON.parse(await readFile(join(root, 'state', 'oap-serve.json'), 'utf8'))).toEqual({
      adapters: changed.hub.adapters,
    });
    expect(await readFile(calls, 'utf8')).toBe('start\nping\nstart\nping\n');
  });

  test('restart stops the running hub and the next start writes the newly saved settings', async () => {
    const { engine, options, calls, root, read } = await fixture();
    const first = await engine.getHub(read());
    const pid = (await first.request('ping')) as number;
    await engine.restart();
    expect(engine.isCurrentHub(first)).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
    const saved = {
      ...options,
      hub: {
        adapters: { 'second-codex': { type: 'codex', executable: join(root, 'codex-2') } },
        environment: { HOME: join(root, 'home') },
      },
    };
    const second = await engine.getHub(read(saved));
    expect(engine.isCurrentHub(second)).toBe(true);
    await second.request('ping');
    expect(JSON.parse(await readFile(join(root, 'state', 'oap-serve.json'), 'utf8'))).toEqual({
      adapters: saved.hub.adapters,
    });
    expect(await readFile(calls, 'utf8')).toBe('start\nping\nstart\nping\n');
  });

  test('a start that fails after restart is retried from the same saved settings', async () => {
    const { engine, options, read } = await fixture();
    await engine.getHub(read());
    await engine.restart();
    await expect(
      engine.getHub(async () => {
        throw new Error('settings unreadable');
      })
    ).rejects.toThrow('settings unreadable');
    const hub = await engine.getHub(read());
    expect(typeof (await hub.request('ping'))).toBe('number');
  });

  test('closing during startup prevents a late hub from being orphaned', async () => {
    const { engine, options, calls, read } = await fixture();
    const starting = engine.getHub(read());
    const closed = engine.close();
    await expect(starting).rejects.toThrow('closed');
    await closed;
    expect(existsSync(calls)).toBe(false);
  });
});
