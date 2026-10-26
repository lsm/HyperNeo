import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = process.env.VERIFY_REPO ?? resolve(import.meta.dir, '../../..');
const RUN = resolve(process.argv[2] ?? '.');
const PORT = Number(process.argv[3] ?? 9311);
const LABEL = process.argv[4] ?? 'run';

const wsEvents: {
  url: string;
  opened: boolean;
  closeCode: number | null;
  tOpen?: number;
  tClose?: number;
}[] = [];
const OrigWebSocket = globalThis.WebSocket;
class CapturingWebSocket extends OrigWebSocket {
  constructor(url: string, protocols?: string | string[]) {
    super(url, protocols);
    const rec = { url, opened: false, closeCode: null as number | null };
    wsEvents.push(rec);
    this.addEventListener('open', () => {
      rec.opened = true;
      rec.tOpen = Date.now();
    });
    this.addEventListener('close', (event: CloseEvent) => {
      rec.closeCode = event.code;
      rec.tClose = Date.now();
    });
  }
}
(globalThis as Record<string, unknown>).WebSocket = CapturingWebSocket;

const docListeners = new Map<string, Set<() => void>>();
const winListeners = new Map<string, Set<() => void>>();
const fire = (map: Map<string, Set<() => void>>, type: string) => {
  for (const fn of map.get(type) ?? []) fn();
};
const documentShim = {
  hidden: false,
  addEventListener: (type: string, fn: () => void) => {
    if (!docListeners.has(type)) docListeners.set(type, new Set());
    docListeners.get(type)!.add(fn);
  },
  removeEventListener: (type: string, fn: () => void) => docListeners.get(type)?.delete(fn),
};
const navigatorShim = { onLine: true, language: 'en', languages: ['en'] };
(globalThis as Record<string, unknown>).document = documentShim;
(globalThis as Record<string, unknown>).navigator = navigatorShim;
(globalThis as Record<string, unknown>).window = {
  addEventListener: (type: string, fn: () => void) => {
    if (!winListeners.has(type)) winListeners.set(type, new Set());
    winListeners.get(type)!.add(fn);
  },
  removeEventListener: (type: string, fn: () => void) => winListeners.get(type)?.delete(fn),
};

const { ConnectionManager } = await import(
  `${REPO}/packages/web/src/lib/connection-manager.ts`
);

const states: string[] = [];
const t0 = Date.now();
const lifecycle = {
  setState: (state: string) => states.push(`${Date.now() - t0} ${state}`),
  getState: () => 'connecting',
  exposeHub: () => {},
  markHubReady: () => {},
  startActions: () => {},
  stopActions: () => {},
  startAudio: () => {},
  stopAudio: () => {},
  startTranscripts: () => {},
  stopTranscripts: () => {},
};
const application = {
  lifecycle,
  createEventEffects: (effects: Record<string, unknown>) => ({ ...effects, ...lifecycle }),
  createResumeEffects: (effects: Record<string, unknown>) => ({ ...effects }),
  markSessionsRecovering: () => {},
};

mkdirSync(join(RUN, 'home'), { recursive: true });
mkdirSync(join(RUN, 'data'), { recursive: true });
mkdirSync(join(RUN, 'evidence'), { recursive: true });

const daemon = spawn(
  'bun',
  [
    'run',
    'packages/cli/main.ts',
    '--port',
    String(PORT),
    '--host',
    '127.0.0.1',
    '--db-path',
    join(RUN, 'data/daemon.db'),
  ],
  {
    cwd: REPO,
    env: {
      HOME: join(RUN, 'home'),
      PATH: `${join(RUN, 'bin')}:${resolve(process.execPath, '..')}:/usr/bin:/bin:/usr/sbin`,
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      HYPERNEO_DATA_DIR: join(RUN, 'data'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);
let daemonLog = '';
daemon.stdout.on('data', (d: Buffer) => (daemonLog += d));
daemon.stderr.on('data', (d: Buffer) => (daemonLog += d));

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const steps: { name: string; at: number }[] = [];
const step = (name: string) => steps.push({ name, at: Date.now() - t0 });
const targetEvents = () => wsEvents.filter((e) => e.url.includes(`:${PORT}`));

let exitCode = 1;
try {
  let ready = false;
  for (let i = 0; i < 120 && !ready; i++) {
    await fetch(`http://127.0.0.1:${PORT}/`).then(() => (ready = true), () => sleep(1000));
  }
  if (!ready) throw new Error('daemon never became ready');
  step('daemon_ready');

  const manager = new ConnectionManager(`ws://0.0.0.0:${PORT}`, application as never);
  await manager.getHub();
  if (!manager.isConnected()) throw new Error('not connected after getHub');
  step('first_connection');

  documentShim.hidden = true;
  navigatorShim.onLine = false;
  fire(docListeners, 'visibilitychange');
  step('hidden_and_offline');

  let suspended = false;
  for (let i = 0; i < 30 && !suspended; i++) {
    await sleep(1000);
    suspended = targetEvents().some((e) => e.closeCode !== null);
  }
  if (!suspended) throw new Error('socket never closed after hiding the page');
  step('suspended_socket_closed');

  const openedBefore = targetEvents().filter((e) => e.opened).length;
  documentShim.hidden = false;
  fire(docListeners, 'visibilitychange');
  step('shown_while_offline');

  let reconnected = false;
  for (let i = 0; i < 70 && !reconnected; i++) {
    await sleep(1000);
    reconnected = targetEvents().filter((e) => e.opened).length > openedBefore;
  }
  step(reconnected ? 'reconnected' : 'no_reconnect_within_70s');

  writeFileSync(
    join(RUN, 'evidence', `${LABEL}-timeline.json`),
    JSON.stringify(
      { label: LABEL, port: PORT, reconnected, lifecycleStates: states, steps, wsEvents },
      null,
      2
    )
  );
  console.log(JSON.stringify({ label: LABEL, reconnected, wsEvents: targetEvents().length }));
  exitCode = reconnected ? 0 : 2;
} catch (error) {
  console.error(String(error));
  writeFileSync(join(RUN, 'evidence', `${LABEL}-error.txt`), String(error));
  writeFileSync(
    join(RUN, 'evidence', `${LABEL}-timeline.json`),
    JSON.stringify({ label: LABEL, error: String(error), steps, wsEvents }, null,
      2
    )
  );
  exitCode = 1;
} finally {
  daemon.kill('SIGTERM');
  await new Promise((done) => {
    daemon.on('exit', done);
    setTimeout(done, 5000);
  });
  writeFileSync(join(RUN, 'evidence', `daemon-${LABEL}.log`), daemonLog);
  process.exit(exitCode);
}
