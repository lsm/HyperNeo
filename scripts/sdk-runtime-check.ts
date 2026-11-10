import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { removeTempDir } from './remove-temp-dir.ts';

const RUN_TIMEOUT_MS = 600_000;
const OLD_DOWNLOAD_CAP_MS = 120_000;
const SLOWEST_OLD_RATE_BYTES_PER_SECOND = 1_175_000;
const DROP_AFTER_BYTES = 10_000_000;
const CHUNK_BYTES = 65_536;
const NPM = 'https://registry.npmjs.org';
const SDK_PACKAGE_PATH = 'packages/daemon/node_modules/@github/copilot-sdk/package.json';

type Runtime = { path: string; source: string; version: string };
type Observed = { claude: Runtime; copilot: Runtime };
type Run = { status: number | null; stdout: string; stderr: string; elapsedMs: number };

function hasNodeModulesAbove(directory: string): boolean {
  const parent = dirname(directory);
  return (
    existsSync(join(directory, 'node_modules')) ||
    (parent !== directory && hasNodeModulesAbove(parent))
  );
}

function runBinary(binary: string, run: string, registry?: string): Promise<Run> {
  const startedAt = Date.now();
  return new Promise((done, fail) => {
    const child = spawn(binary, ['--hyperneo-sdk-runtime-check'], {
      cwd: run,
      timeout: RUN_TIMEOUT_MS,
      env: {
        HOME: join(run, 'home'),
        USERPROFILE: join(run, 'home'),
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: join(run, 'tmp'),
        TMP: join(run, 'tmp'),
        TMPDIR: join(run, 'tmp'),
        HYPERNEO_DATA_DIR: join(run, 'data'),
        NODE_ENV: 'test',
        ...(registry ? { npm_config_registry: registry } : {}),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => (stdout += data));
    child.stderr.on('data', (data) => (stderr += data));
    child.on('error', fail);
    child.on('close', (status) =>
      done({ status, stdout, stderr, elapsedMs: Date.now() - startedAt })
    );
  });
}

function observed(result: Run): Observed {
  if (result.status !== 0)
    throw new Error(`SDK runtime check failed (${result.status}):\n${result.stderr}`);
  return JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
}

function expectRuntimes(result: Observed, source: string, run: string, copilotVersion: string) {
  for (const runtime of [result.claude, result.copilot])
    if (runtime.source !== source || !runtime.path.startsWith(join(run, 'data')))
      throw new Error(`Expected a ${source} runtime in ${run}: ${JSON.stringify(runtime)}`);
  if (!result.claude.version) throw new Error('Claude Code reported no version');
  if (result.copilot.version !== copilotVersion)
    throw new Error(`Expected Copilot ${copilotVersion}: ${JSON.stringify(result.copilot)}`);
}

function prepareRun(compiledBinary: string): { run: string; binary: string } {
  const run = mkdtempSync(join(tmpdir(), 'hyperneo-sdk-check-'));
  if (hasNodeModulesAbove(run)) throw new Error(`${run} can reach a node_modules folder`);
  for (const part of ['home', 'data', 'tmp']) mkdirSync(join(run, part));
  const binary = join(run, basename(compiledBinary));
  copyFileSync(resolve(compiledBinary), binary);
  return { run, binary };
}

async function serveSlowly(res: ServerResponse, body: Buffer, rate: number, dropAt?: number) {
  const end = dropAt ?? body.length;
  for (let sent = 0; sent < end; sent += CHUNK_BYTES) {
    if (res.destroyed) return;
    res.write(body.subarray(sent, Math.min(sent + CHUNK_BYTES, end)));
    if (rate) await new Promise((wake) => setTimeout(wake, (CHUNK_BYTES / rate) * 1000));
  }
  if (dropAt) res.destroy();
  else res.end();
}

async function startMirror() {
  const tarballs = new Map<string, Buffer>();
  const ranges: number[] = [];
  let dropped = false;
  let rate = 0;

  async function tarball(url: string): Promise<Buffer> {
    const known = tarballs.get(url);
    if (known) return known;
    const body = Buffer.from(await (await fetch(url)).arrayBuffer());
    tarballs.set(url, body);
    return body;
  }

  async function serveTarball(req: IncomingMessage, res: ServerResponse, url: string) {
    const body = await tarball(url);
    if (!url.includes('claude-agent-sdk')) {
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
      return;
    }
    const offset = Number(/^bytes=(\d+)-/.exec(req.headers.range ?? '')?.[1] ?? 0);
    ranges.push(offset);
    const rest = body.subarray(offset);
    res.writeHead(offset ? 206 : 200, {
      'Content-Length': rest.length,
      ...(offset ? { 'Content-Range': `bytes ${offset}-${body.length - 1}/${body.length}` } : {}),
    });
    rate = Math.min(
      SLOWEST_OLD_RATE_BYTES_PER_SECOND * 0.9,
      (body.length - DROP_AFTER_BYTES) / ((OLD_DOWNLOAD_CAP_MS + 10_000) / 1000)
    );
    const dropAt = dropped ? undefined : DROP_AFTER_BYTES;
    dropped = true;
    await serveSlowly(res, rest, rate, dropAt);
  }

  const server = createServer((req, res) => {
    const handle = async () => {
      const path = req.url ?? '/';
      if (path.startsWith('/tarball/')) {
        await serveTarball(req, res, decodeURIComponent(path.slice('/tarball/'.length)));
        return;
      }
      const meta = await (await fetch(`${NPM}${path}`)).json();
      const { port } = server.address() as AddressInfo;
      meta.dist.tarball = `http://127.0.0.1:${port}/tarball/${encodeURIComponent(meta.dist.tarball)}`;
      res.end(JSON.stringify(meta));
    };
    handle().catch(() => res.destroy());
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    ranges,
    rate: () => rate,
    close: () => server.close(),
  };
}

function partialBytes(run: string): number {
  const sdk = join(run, 'data', 'sdk');
  const partial = readdirSync(sdk).find((name) => name.endsWith('.tgz.partial'));
  return partial ? statSync(join(sdk, partial)).size : 0;
}

async function checkSlowInterruptedDownload(compiledBinary: string, copilotVersion: string) {
  const { run, binary } = prepareRun(compiledBinary);
  const mirror = await startMirror();
  try {
    const interrupted = await runBinary(binary, run, mirror.url);
    if (interrupted.status === 0 || !interrupted.stderr.includes('cannot reach npm'))
      throw new Error(`Expected a named network failure:\n${interrupted.stderr}`);
    const kept = partialBytes(run);
    if (kept === 0) throw new Error('The interrupted download kept no partial file');

    const resumed = await runBinary(binary, run, mirror.url);
    expectRuntimes(observed(resumed), 'download', run, copilotVersion);
    if (mirror.ranges.at(-1) !== kept)
      throw new Error(`Expected a resume from ${kept}: ${mirror.ranges.join(', ')}`);
    if (resumed.elapsedMs <= OLD_DOWNLOAD_CAP_MS)
      throw new Error(`Throttled download finished too fast: ${resumed.elapsedMs}ms`);
    const mbps = (mirror.rate() * 8) / 1_000_000;
    console.log(
      `PASS: resumed from ${kept} bytes at ${mbps.toFixed(1)} Mbps in ${resumed.elapsedMs}ms`
    );
  } finally {
    mirror.close();
    removeTempDir(run);
  }
}

export async function checkSdkRuntimes(compiledBinary: string, network = false): Promise<void> {
  const sdkPackage = join(import.meta.dir, '..', SDK_PACKAGE_PATH);
  const { copilotCliVersion } = JSON.parse(readFileSync(sdkPackage, 'utf8'));
  const { run, binary } = prepareRun(compiledBinary);
  try {
    expectRuntimes(observed(await runBinary(binary, run)), 'download', run, copilotCliVersion);
    expectRuntimes(observed(await runBinary(binary, run)), 'cache', run, copilotCliVersion);
    console.log(`PASS: ${basename(compiledBinary)} started Claude and Copilot`);
  } finally {
    removeTempDir(run);
  }
  if (network) await checkSlowInterruptedDownload(compiledBinary, copilotCliVersion);
}

if (import.meta.main) {
  const [compiledBinary, mode] = process.argv.slice(2);
  if (!compiledBinary) throw new Error('usage: sdk-runtime-check.ts <compiled-binary> [--network]');
  await checkSdkRuntimes(compiledBinary, mode === '--network');
}
