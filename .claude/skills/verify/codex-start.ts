import { codexDesktopProject } from '../../../packages/daemon/src/lib/drivers/codex-desktop-project.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  connectCodexAppServer,
  startCodexBootstrapServer,
} from '../../../packages/daemon/src/lib/drivers/codex-app-server.ts';
import { createCodexDesktopAdapter } from '../../../packages/daemon/src/lib/drivers/codex-desktop-adapter.ts';
import { withCodexDesktopIpc } from '../../../packages/daemon/src/lib/drivers/codex-desktop-ipc.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';

const [, , action, run] = process.argv;
if (!run || process.env.NODE_ENV !== 'test')
  throw new Error('NODE_ENV=test bun codex-start.ts prepare|start|observe <fresh-run-dir>');
const home = join(homedir(), '.codex');
const record = join(run, 'opening.json');
const save = (name: string, value: unknown) =>
  writeFileSync(join(run, `${name}.json`), JSON.stringify(value, null, 2));
if (action === 'prepare') {
  if (existsSync(record)) throw new Error('Use a fresh run directory');
  const folder = join(run, 'workspace');
  mkdirSync(folder, { recursive: true });
  const adapter = createCodexDesktopAdapter({
    statePath: join(home, 'state_5.sqlite'),
    worktreesDir: join(run, 'worktrees'),
    machine: 'verify',
    now: Date.now,
    spawn: spawnProcess,
    appServer: () =>
      connectCodexAppServer(join(home, 'app-server-control/app-server-control.sock')),
    bootstrapServer: () => startCodexBootstrapServer(),
    prepareDesktopProject: async (folder) => {
      const state = JSON.parse(readFileSync(join(home, '.codex-global-state.json'), 'utf8'));
      const id = codexDesktopProject(state, folder, home);
      if (!id) throw new Error(`Manually register codex://threads/new?${new URLSearchParams({ path: folder })} first`);
      return id;
    },
    startDesktopTurn: async (threadId, request) => {
      save('opening', { threadId, request });
      throw new Error('Paused before Desktop handoff for manual opening');
    },
    folderExists: existsSync,
    makeFolder: (path) => mkdirSync(path),
    homeDir: homedir(),
    gitCheckout: async () => null,
    newId: () => crypto.randomUUID(),
  });
  save(
    'prepare-result',
    await adapter.start!(
      {
        place: { machine: 'verify', folder, name: 'HyperNeo Desktop opening verification' },
        title: 'HyperNeo Desktop opening verification',
        message: 'Reply exactly DESKTOP_OPENING_VERIFIED. Do not use tools or read any files.',
      },
      { from: 'user', caller: { source: 'rpc' } }
    )
  );
  if (!existsSync(record)) throw new Error('Thread preparation failed; see prepare-result.json');
  const { threadId } = JSON.parse(readFileSync(record, 'utf8'));
  console.log(`Manually open codex://threads/${threadId}, then run start. Do not restart Desktop.`);
} else {
  const { threadId, request } = JSON.parse(readFileSync(record, 'utf8'));
  if (action === 'start') {
    const response = await withCodexDesktopIpc(join(home, 'ipc/ipc.sock'), async ({ call }) => {
      const owner = await call(
        'thread-owner-discovery',
        { hostId: 'local', conversationId: threadId },
        1
      );
      if (owner.resultType !== 'success' || !owner.handledByClientId)
        throw new Error('Manually open the verification thread in Desktop first');
      return call(
        'thread-follower-start-turn',
        { conversationId: threadId, turnStart: { request, context: { inheritThreadSettings: false } } },
        2,
        owner.handledByClientId
      );
    });
    save('start-result', response);
    if (response.resultType !== 'success') throw new Error(response.error);
    console.log('Opening turn submitted. Human: confirm the reply renders without a restart.');
  } else if (action === 'observe') {
    const server = await connectCodexAppServer(
      join(home, 'app-server-control/app-server-control.sock')
    );
    try {
      const thread = await server.call('thread/read', { threadId, includeTurns: false });
      const turns = await server.call('thread/turns/list', { threadId, limit: 1 });
      save('observed', { thread, turns });
      console.log(JSON.stringify({ thread, turns }));
      console.log('This records backend facts only; human confirmation is required for GUI rendering.');
    } finally {
      await server.close();
    }
  } else throw new Error(`Unknown action: ${action}`);
}
