import { describe, expect, test } from 'bun:test';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const original = readFileSync(
  new URL('./fixtures/deno-health-inline.txt', import.meta.url),
  'utf8'
);
const extracted = join(root, 'scripts/deno-health-probe.mjs');

describe('extracted authenticated health probe', () => {
  test('preserves the inline program with formatting as the only change', () => {
    const format = (program: string) =>
      execFileSync(
        join(root, 'node_modules/.bin/biome'),
        ['format', '--stdin-file-path=health.mjs'],
        { input: program, encoding: 'utf8' }
      );
    expect(format(readFileSync(extracted, 'utf8'))).toBe(format(original));
  });

  test.each(['ok', 'unexpected-status', 'rpc-error', 'unauthorized'])(
    'preserves the network result for %s',
    async (mode) => {
      const current = readFileSync(extracted, 'utf8');
      const run = mkdtempSync(join(tmpdir(), 'health-extract-'));
      const credential = join(run, 'local-rpc.credential');
      writeFileSync(credential, 'synthetic-local-secret\n', { mode: 0o600 });
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        verifyClient: ({ req }) =>
          mode !== 'unauthorized' && req.headers.authorization === 'Bearer synthetic-local-secret',
      });
      await new Promise<void>((done, fail) => {
        server.once('listening', done);
        server.once('error', fail);
      });
      const requests: unknown[] = [];
      server.on('connection', (socket) =>
        socket.on('message', (raw) => {
          const request = JSON.parse(String(raw));
          requests.push({ ...request, id: '', timestamp: '' });
          socket.send('not-json');
          socket.send(JSON.stringify({ id: 'unrelated', data: { status: 'wrong' } }));
          socket.send(
            JSON.stringify({
              requestId: request.id,
              data: { status: mode === 'unexpected-status' ? 'wrong' : 'ok' },
              ...(mode === 'rpc-error' ? { error: 'synthetic RPC rejection' } : {}),
            })
          );
        })
      );
      try {
        const address = server.address();
        if (typeof address !== 'object' || address === null) throw new Error('No fixture address');
        const outputs = [];
        for (const program of [original, current]) {
          const wsModule = pathToFileURL(createRequire(import.meta.url).resolve('ws')).href;
          const adapted = program.replace('npm:ws@8.21.3', wsModule);
          const child = spawn(
            'bun',
            [
              '-e',
              'globalThis.Deno={env:{get:(key)=>process.env[key]},readTextFile:(path)=>import("node:fs/promises").then(fs=>fs.readFile(path,"utf8")),exit:(code)=>process.exit(code)};\n' +
                adapted,
            ],
            {
              env: {
                PATH: process.env.PATH,
                HOME: run,
                TMPDIR: run,
                NODE_ENV: 'test',
                SMOKE_CREDENTIAL_FILE: credential,
                SMOKE_WS_URL: 'ws://127.0.0.1:' + address.port + '/ws',
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            }
          );
          let stdout = '',
            stderr = '';
          child.stdout.on('data', (chunk) => {
            stdout += chunk;
          });
          child.stderr.on('data', (chunk) => {
            stderr += chunk;
          });
          const timer = setTimeout(() => child.kill('SIGTERM'), 35000);
          try {
            const code = await new Promise<number | null>((done, fail) => {
              child.once('close', done);
              child.once('error', fail);
            });
            outputs.push({ code, stdout, stderr });
          } finally {
            clearTimeout(timer);
          }
        }
        expect(outputs[1]).toEqual(outputs[0]);
        expect(outputs[1].code).toBe(mode === 'ok' ? 0 : 1);
        if (mode === 'ok') expect(outputs[1].stdout).toContain('system.health RPC ok');
        else expect(outputs[1].stderr).toContain('FAIL:');
        if (mode !== 'unauthorized') {
          expect(requests).toHaveLength(2);
          expect(requests[1]).toEqual(requests[0]);
          expect(requests[0]).toMatchObject({
            method: 'system.health',
            sessionId: 'global',
            data: {},
          });
        }
      } finally {
        server.clients.forEach((client) => client.terminate());
        await new Promise<void>((done) => server.close(() => done()));
        rmSync(run, { recursive: true, force: true });
      }
    },
    90000
  );

  test('shell preserves credential and URL environment and quotes the extracted filename', () => {
    const runner = readFileSync(join(root, 'scripts/deno-smoke.sh'), 'utf8');
    const command = runner
      .split('\n')
      .find(
        (line) =>
          line.startsWith('if ! SMOKE_CREDENTIAL_FILE=') && line.includes('deno-health-probe.mjs')
      );
    expect(command).toBeDefined();
    const shell =
      'deno() { printf "%s\\0" "$SMOKE_CREDENTIAL_FILE" "$SMOKE_WS_URL" "$@"; };\n' +
      command!.slice(5, -6);
    const result = execFileSync('/bin/bash', ['-c', shell], {
      env: { REPO_ROOT: '/synthetic repo', WORK_DIR: '/synthetic tmp', PORT: '12345' },
      encoding: 'utf8',
    });
    expect(result.split('\0').slice(0, -1)).toEqual([
      '/synthetic tmp/data/local-rpc.credential',
      'ws://localhost:12345/ws',
      'run',
      '-A',
      '--config',
      '/synthetic repo/packages/daemon/deno.json',
      '/synthetic repo/scripts/deno-health-probe.mjs',
    ]);
  });
});
