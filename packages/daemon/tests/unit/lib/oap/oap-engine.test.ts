import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OapEngine } from '../../../../src/lib/oap/oap-engine';

const roots: string[] = [];
const engines: OapEngine[] = [];

async function fixture() {
  const { OapEngine } = await import('../../../../src/lib/oap/oap-engine');
  const root = await mkdtemp(join(tmpdir(), 'oap-engine-'));
  roots.push(root);
  const binaryPath = join(root, 'synthetic-hub');
  const calls = join(root, 'calls');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const calls = ${JSON.stringify(calls)};
if (process.argv[2] === '--version') { console.log('synthetic-1'); process.exit(0); }
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
  const options = {
    binaryPath,
    identity: { version: 'synthetic-1', sha256: createHash('sha256').update(script).digest('hex') },
    stateDirectory: join(root, 'state'),
    codexExecutable: join(root, 'codex'),
    codexHome: join(root, 'codex-home'),
  };
  const engine = new OapEngine();
  engines.push(engine);
  return { root, calls, options, engine };
}

afterEach(async () => {
  await Promise.all(engines.splice(0).map((engine) => engine.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('OapEngine', () => {
  test('starts one validated hub lazily for concurrent callers and stops it on close', async () => {
    const { engine, options, calls, root } = await fixture();
    expect(existsSync(calls)).toBe(false);
    const [first, second] = await Promise.all([engine.getHub(options), engine.getHub(options)]);
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
    expect(launch.env).toEqual({ HOME: options.stateDirectory, CODEX_HOME: options.codexHome });
    expect(JSON.parse(await readFile(join(root, 'state', 'oap-serve.json'), 'utf8'))).toEqual({
      adapters: {
        codex: {
          type: 'codex',
          executable: options.codexExecutable,
          environment: ['CODEX_HOME'],
          approval_policy: 'on-request',
          sandbox: 'workspace-write',
        },
      },
    });
    await engine.close();
    expect(() => process.kill(pid, 0)).toThrow();
    await expect(engine.getHub(options)).rejects.toThrow('closed');
  });

  test('rejects a mismatched binary before starting or writing configuration', async () => {
    const { engine, options, calls } = await fixture();
    await expect(
      engine.getHub({ ...options, identity: { ...options.identity, sha256: '0'.repeat(64) } })
    ).rejects.toThrow('sha256_mismatch');
    expect(existsSync(calls)).toBe(false);
    expect(existsSync(join(options.stateDirectory, 'oap-serve.json'))).toBe(false);
  });

  test('rejects an incomplete expected binary identity', async () => {
    const { engine, options } = await fixture();
    await expect(
      engine.getHub({ ...options, identity: { version: '', sha256: options.identity.sha256 } })
    ).rejects.toThrow('invalid OAP binary identity');
    await expect(
      engine.getHub({ ...options, identity: { version: 'synthetic-1', sha256: 'not-a-sha256' } })
    ).rejects.toThrow('invalid OAP binary identity');
  });

  test('does not resend the failed request when a crashed hub is restarted on later use', async () => {
    const { engine, options, calls } = await fixture();
    const first = await engine.getHub(options);
    await expect(first.request('crash')).rejects.toThrow('code=7');
    const second = await engine.getHub(options);
    expect(second).not.toBe(first);
    await second.request('ping');
    expect(await readFile(calls, 'utf8')).toBe('start\ncrash\nstart\nping\n');
  });

  test('does not allow a second configuration to silently replace a running hub', async () => {
    const { engine, options } = await fixture();
    await engine.getHub(options);
    await expect(
      engine.getHub({ ...options, codexHome: join(options.codexHome, 'other') })
    ).rejects.toThrow('configuration');
  });

  test('closing during startup prevents a late hub from being orphaned', async () => {
    const { engine, options, calls } = await fixture();
    const starting = engine.getHub(options);
    const closed = engine.close();
    await expect(starting).rejects.toThrow('closed');
    await closed;
    expect(existsSync(calls)).toBe(false);
  });
});
