import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MessageHub, WebSocketClientTransport } from '../../../packages/shared/src/mod.ts';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import { createLocalSocket } from '../../../packages/daemon/src/lib/pairing/local-credential.ts';
import fixtures from './fixtures/live-media-a3.json';

const run = process.argv.at(-1)!;
const home = join(run, 'home');
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, home);
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
const folder = join(home, 'Screenshots');
await mkdir(folder);
await mkdir(join(run, 'evidence'));
await writeFile(join(run, 'bin', 'gh'), '#!/bin/sh\nexit 73\n', { mode: 0o755 });
const images = [
  { path: join(folder, 'contact-sheet.png'), bytes: Buffer.from(fixtures.png, 'base64') },
  { path: join(folder, 'before.png'), bytes: Buffer.from(fixtures.png, 'base64') },
  { path: join(folder, 'after.jpg'), bytes: Buffer.from(fixtures.jpg, 'base64') },
];
for (const item of images) await writeFile(item.path, item.bytes);

const app = await createDaemonApp({
  config: {
    ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data', 'daemon.db') }),
    disableWorktrees: true,
  },
  verbose: false,
});
const hub = new MessageHub({ defaultSessionId: 'global' });
const transport = new WebSocketClientTransport({
  url: `ws://127.0.0.1:${app.server.port}/ws`,
  createSocket: createLocalSocket,
  autoReconnect: false,
});
hub.registerTransport(transport);
const observed = { imagesRead: 0, folderRefused: false, guidancePresent: false };

try {
  await app.spaceRuntimeService.ready();
  await app.jobProcessor.stop();
  await transport.initialize();
  const invoke = <T>(name: string, input: object) =>
    hub.request<T>('operation.invoke', { name, input });
  const { sessionId } = await invoke<{ sessionId: string }>('neo.open', {});
  assert(sessionId?.startsWith('neo:'));
  const { session } = await hub.request<{ session: { config: { systemPrompt: string } } }>(
    'session.get',
    { sessionId }
  );
  const mcp = createOperationMcpHandler(
    () => app.sessionManager.getOperationRegistry(),
    () => ({ sessionId, role: 'neo' })
  );
  const [sheet, before, after] = images;
  const result = await mcp({
    name: 'neo.publication.publish',
    input: {
      requestId: 'screenshot-card-guidance',
      text: `Before and after contact sheet: \`${sheet.path}\``,
      details: `Originals:\n- \`${before.path}\`\n- \`${after.path}\`\n\nFolder: \`${folder}/\``,
    },
  });
  assert(!result.isError);
  const published = JSON.parse(result.content[0].text);
  assert(published.accepted);
  const read = (reference: string) =>
    invoke<{ accepted: boolean; reason?: string; kind?: string; data?: string }>('file.reference.read', {
      sourceMessageOrCard: { kind: 'publication', id: published.publication.publicationId },
      reference,
    });
  for (const item of images) {
    const file = await read(item.path);
    assert.equal(file.kind, 'image');
    assert.deepEqual(Buffer.from(file.data!, 'base64'), item.bytes);
    observed.imagesRead++;
  }
  assert.equal((await read(`${folder}/`)).reason, 'forbidden');
  observed.folderRefused = true;
  const prompt = session.config.systemPrompt;
  observed.guidancePresent =
    prompt.includes('list each absolute PNG or JPEG path in the same card') &&
    prompt.includes('PNG contact sheet');
  assert(observed.guidancePresent, 'The running Neo session lacks screenshot delivery guidance');
} finally {
  await transport.close();
  await app.cleanup();
  await writeFile(join(run, 'evidence', 'observed.json'), JSON.stringify(observed, null, 2));
}
console.log(JSON.stringify(observed));
