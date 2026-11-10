import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createHttpWsServer } from '../../../packages/daemon/src/lib/runtime-server/index.ts';
import { createWebSocketHandlers } from '../../../packages/daemon/src/routes/setup-websocket.ts';
import { captureGitArtifact } from '../../../packages/daemon/src/lib/artifacts/git-capture.ts';
import { NeoAskTodoRepository } from '../../../packages/daemon/src/storage/repositories/neo-ask-todo-repository.ts';
import { NeoTodoSessionRepository } from '../../../packages/daemon/src/storage/repositories/neo-todo-session-repository.ts';
import { NeoRepository } from '../../../packages/daemon/src/storage/repositories/neo-repository.ts';
import { DevicePairingRepository } from '../../../packages/daemon/src/storage/repositories/device-pairing-repository.ts';
import { NeoPublicationRepository } from '../../../packages/daemon/src/storage/repositories/neo-publication-repository.ts';
import type { ArtifactRef } from '../../../packages/shared/src/types/artifact-file.ts';

const run = process.argv.at(-1)!;
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
for (const name of ['workspace', 'evidence']) mkdirSync(join(run, name), { recursive: true });
writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 73\n', { mode: 0o755 });
const workspace = join(run, 'workspace');
const mp4 = join(workspace, 'sample.mp4');
execFileSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=15',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100',
    '-t',
    '8',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-b:v',
    '800k',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
    '-y',
    mp4,
  ],
  { timeout: 30000 }
);
execFileSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    mp4,
    '-c',
    'copy',
    '-f',
    'mov',
    '-y',
    join(workspace, 'sample.mov'),
  ],
  { timeout: 30000 }
);
const movie = readFileSync(mp4);
let app: Awaited<ReturnType<typeof createDaemonApp>> | undefined;
let preview: Awaited<ReturnType<typeof createHttpWsServer>> | undefined;
let externalRequests = 0;
const tripwire = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    externalRequests++;
    const refused = await app!.guardRequest(req);
    return refused ?? new Response(movie, { headers: { 'content-type': 'video/mp4' } });
  },
});
assert(![8399, 8499].includes(tripwire.port!));
const box = (type: string, bytes: Buffer) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(bytes.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, bytes]);
};
function externalMovie(bytes: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; ) {
    const size = bytes.readUInt32BE(offset);
    assert(size >= 8 && offset + size <= bytes.length);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + size);
    parts.push(
      type === 'dref'
        ? box(
            type,
            Buffer.concat([
              body.subarray(0, 8),
              box(
                'url ',
                Buffer.concat([
                  Buffer.alloc(4),
                  Buffer.from(`http://127.0.0.1:${tripwire.port}/media\0`),
                ])
              ),
            ])
          )
        : ['moov', 'trak', 'mdia', 'minf', 'dinf'].includes(type)
          ? box(type, externalMovie(body))
          : bytes.subarray(offset, offset + size)
    );
    offset += size;
  }
  return Buffer.concat(parts);
}
writeFileSync(join(workspace, 'external.mp4'), externalMovie(movie));
try {
  app = await createDaemonApp({
    config: {
      ...getConfig({
        port: 0,
        host: '127.0.0.1',
        dbPath: join(run, 'data/daemon.db'),
        workspaceRoot: run,
      }),
      disableWorktrees: true,
    },
    standalone: false,
    verbose: false,
  });
  await app.jobProcessor.stop();
  assert(![8399, 8499].includes(app.server.port));
  const db = app.db.getDatabase();
  const conversationId = randomUUID();
  const neoId = `neo:${conversationId}`;
  for (const id of ['worker', neoId])
    await app.db.createSession({
      id,
      title: 'Video preview',
      workspacePath: workspace,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      status: 'active',
      config: { queryMode: 'manual' },
      metadata: {},
    } as never);
  const neo = new NeoRepository(db);
  neo.reserveBinding({ sessionId: neoId, kind: 'neo', projectId: null });
  assert.equal(neo.conversationId(), conversationId);
  const work = new NeoAskTodoRepository(db);
  work.openAsk({
    id: 'ask',
    projectId: null,
    sessionId: neoId,
    originMessageId: null,
    title: 'Video preview',
    request: '',
    createdAt: 1,
  });
  work.addTodo(
    'video',
    'ask',
    { title: 'Video preview', instruction: null, named: null, check: null, doneWhen: 'Done' },
    2
  );
  const sessions = new NeoTodoSessionRepository(db);
  sessions.create('video', {
    verb: 'start',
    adapter: 'hyperneo',
    place: { machine: 'local', name: 'Synthetic', folder: workspace },
  });
  sessions.recordRef('video', { adapter: 'hyperneo', id: 'worker' });
  const refs: Record<string, ArtifactRef> = {};
  for (const name of ['sample.mp4', 'sample.mov', 'external.mp4']) {
    const bytes = readFileSync(join(workspace, name));
    const captured = (await captureGitArtifact(
      db,
      join(run, 'data'),
      {
        repository: 'github.com/example/video',
        sha: 'a'.repeat(40),
        path: name,
        context: { kind: 'todo', id: 'video' },
      },
      randomUUID(),
      async () => true,
      async () => ({
        accepted: true,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        blobSha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'),
      })
    )) as { accepted: boolean; artifact: ArtifactRef };
    assert(captured.accepted);
    refs[name] = captured.artifact;
  }
  const paths = ['sample.mp4', 'sample.mov', 'external.mp4'].map((name) => join(workspace, name));
  const text = 'Video samples: ' + paths.map((path) => `\`${path}\``).join(', ') + '.';
  const publicationId = randomUUID();
  assert(
    new NeoPublicationRepository(db).append({
      conversationId,
      publicationId,
      shortText: text,
      fullText: text,
      links: [],
    }).accepted
  );
  const counts = () => db.prepare('SELECT COUNT(*) AS n FROM artifact_files').get();
  const before = counts();
  const dist = resolve('packages/web/dist');
  preview = await createHttpWsServer({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req, upgrade, client) {
      const refused = await app!.guardRequest(req);
      if (refused) return refused;
      const url = new URL(req.url);
      if (url.pathname === '/pair' && req.method === 'POST') return app!.handlePair(req);
      if (url.pathname === '/ws') {
        const device = await app!.authenticateUpgrade(req, client?.remoteAddress ?? null);
        if (!device) return new Response('Pairing required', { status: 401 });
        if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
          return new Response(null, { status: 204 });
        return (
          upgrade(req, { connectionSessionId: 'global', device }) ??
          new Response('Upgrade failed', { status: 500 })
        );
      }
      const path =
        url.pathname === '/neo' || url.pathname === '/neo/'
          ? 'neo/index.html'
          : url.pathname === '/'
            ? 'index.html'
            : decodeURIComponent(url.pathname).slice(1);
      const full = resolve(dist, path);
      if (!full.startsWith(`${dist}/`)) return new Response('', { status: 404 });
      const file = Bun.file(full);
      return (await file.exists())
        ? new Response(file, { headers: { 'Cache-Control': 'no-store' } })
        : new Response('', { status: 404 });
    },
    websocket: createWebSocketHandlers(app.transport, app.sessionManager),
  });
  assert(![8399, 8499].includes(preview.port));
  writeFileSync(
    join(run, 'fixture.json'),
    JSON.stringify({
      port: preview.port,
      refs,
      paths,
      publicationId,
      pairCodes: [1280, 390].map(
        () =>
          new DevicePairingRepository(db).createCode(
            'human',
            'Video proof browser',
            true,
            Date.now()
          ).code
      ),
    })
  );
  const child = Bun.spawn(
    [
      'node',
      fileURLToPath(new URL('./video-web-browser.mjs', import.meta.url)),
      run,
      ...(process.argv.includes('--red') ? ['--red'] : []),
    ],
    { env: process.env, stdout: 'pipe', stderr: 'inherit' }
  );
  const output = await new Response(child.stdout).text();
  assert.equal(await child.exited, 0, output.slice(-2000));
  assert.equal(externalRequests, 0);
  assert.deepEqual(counts(), before);
  writeFileSync(
    join(run, 'evidence/daemon-video-web.json'),
    JSON.stringify({
      passed: true,
      externalRequests,
      rowCount: before,
      byteLength: movie.length,
      port: preview.port,
    })
  );
  console.log(output.trim());
} finally {
  preview?.stop(true);
  tripwire.stop(true);
  await app?.cleanup();
}
