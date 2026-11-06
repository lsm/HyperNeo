import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { mock, spyOn } from 'bun:test';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(homedir(), join(run, 'home'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const service = join(homedir(), '.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService');
const pid = 987654;
const name = 'Codex Computer Use interaction';
let young = false, recent = false, failSignal = false, denyRead = false, auto = false;
let failNotice = false;
let becomeYoungAfterRead = false;
let hold: Promise<void> | undefined;
const commands: { file: string; args: string[] }[] = [];
const notices: string[] = [];
const signals: { pid: number; signal: string }[] = [];
const timers: { callback: () => void; delay: number; unref: boolean; cleared: boolean }[] = [];
const events: unknown[] = [];
const realChild = await import('node:child_process');
const fakeExecFile = Object.assign(() => { throw new Error('Use promisified fixture only'); }, {
  [promisify.custom]: async (file: string, args: string[], options: { timeout: number; maxBuffer: number }) => {
    assert.equal(options.timeout, 10_000);
    assert.equal(options.maxBuffer, 32 * 1024 * 1024);
    commands.push({ file, args });
    if (file === '/usr/bin/pmset' && args[1] === 'assertions') {
      if (denyRead) throw new Error('synthetic pmset refusal');
      await hold;
      const age = young ? '00:00:01' : '20:00:00';
      if (becomeYoungAfterRead) young = true;
      return { stdout: `Listed by owning process:\n pid ${pid}(SkyComputerUseService): [0x0000000500000001] ${age} PreventUserIdleDisplaySleep named: "${name}"\n`, stderr: '' };
    }
    if (file === '/usr/bin/pmset' && args[1] === 'log') {
      const at = new Date(Date.now() - (recent ? 1_000 : 600_000)).toISOString().slice(0, 19).replace('T', ' ');
      return { stdout: `${at} +0000 Assertions PID ${pid}(SkyComputerUseService) Created PreventUserIdleDisplaySleep "${name}" 00:00:00\n`, stderr: '' };
    }
    if (file === '/bin/ps') return { stdout: `${pid} ${process.getuid!()} Mon Nov  2 08:00:00 2026 ${service}\n`, stderr: '' };
    if (file === '/usr/bin/osascript') {
      assert.equal(args[0], '-e');
      assert(args[1].includes('display notification (item 1 of argv)'));
      notices.push(args[2]);
      if (failNotice) throw new Error('synthetic notification refusal');
      return { stdout: '', stderr: '' };
    }
    throw new Error(`Refused unexpected command ${file}`);
  },
});
mock.module('node:child_process', () => ({ ...realChild, execFile: fakeExecFile }));
const kill = spyOn(process, 'kill').mockImplementation((target, signal) => {
  assert.equal(target, pid);
  assert.equal(signal, 'SIGTERM');
  signals.push({ pid: target, signal: String(signal) });
  if (failSignal) throw new Error('synthetic signal refusal');
  return true;
});
const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
  const timer = { callback, delay, unref: false, cleared: false };
  timers.push(timer);
  return { unref: () => { timer.unref = true; }, timer };
}) as typeof setInterval);
const clear = spyOn(globalThis, 'clearInterval').mockImplementation(((handle: { timer: typeof timers[number] }) => {
  handle.timer.cleared = true;
}) as typeof clearInterval);
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
Object.defineProperty(process, 'platform', { value: 'darwin' });
const { subscribeToStructuredLogs } = await import('../../../packages/daemon/src/lib/logger.ts');
const unsubscribe = subscribeToStructuredLogs((event) => { if (event.module.includes('codex-cu')) events.push(event); });
const { startCuChecker } = await import('../../../packages/daemon/src/lib/drivers/codex-cu-reaper.ts');
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const closeAll: (() => Promise<void>)[] = [];
try {
  const close = startCuChecker(() => auto);
  closeAll.push(close);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 60_000);
  assert(timers[0].unref);
  timers[0].callback(); await settle();
  assert.equal(notices.length, 1);
  assert.equal(notices[0], `Computer Use display-sleep assertion leak; action: kill -TERM ${pid} (SkyComputerUseService only).`);
  assert.equal(signals.length, 0);
  timers[0].callback(); await settle();
  assert.equal(notices.length, 1);
  auto = true;
  const before = commands.filter((entry) => entry.args[1] === 'assertions').length;
  timers[0].callback(); await settle();
  assert.equal(commands.filter((entry) => entry.args[1] === 'assertions').length - before, 2);
  assert.deepEqual(signals, [{ pid, signal: 'SIGTERM' }]);
  timers[0].callback(); await settle();
  assert.equal(signals.length, 1);
  await close();
  assert(timers[0].cleared);
  const afterClose = commands.length;
  timers[0].callback(); await settle();
  assert.equal(commands.length, afterClose);

  for (const scenario of ['young', 'recent', 'read-failure', 'signal-failure'] as const) {
    young = scenario === 'young'; recent = scenario === 'recent'; denyRead = scenario === 'read-failure'; failSignal = scenario === 'signal-failure';
    const end = startCuChecker(() => true); closeAll.push(end);
    const timer = timers.at(-1)!;
    const beforeSignals = signals.length;
    timer.callback(); await settle(); timer.callback(); await settle();
    assert.equal(signals.length - beforeSignals, scenario === 'signal-failure' ? 1 : 0);
    await end();
  }
  young = recent = denyRead = failSignal = false;
  failNotice = true;
  const closeFailedNotice = startCuChecker(() => false); closeAll.push(closeFailedNotice);
  const failedNoticeTimer = timers.at(-1)!;
  const beforeFailedNotices = notices.length;
  failedNoticeTimer.callback(); await settle(); failedNoticeTimer.callback(); await settle();
  assert.equal(notices.length - beforeFailedNotices, 1, 'A failed notification must not retry');
  await closeFailedNotice();
  failNotice = false;
  becomeYoungAfterRead = true;
  const closeCancelled = startCuChecker(() => true); closeAll.push(closeCancelled);
  const beforeCancelledSignals = signals.length, beforeCancelledEvents = events.length;
  timers.at(-1)!.callback(); await settle();
  assert.equal(signals.length, beforeCancelledSignals);
  assert.equal(events.slice(beforeCancelledEvents).filter((event) => JSON.stringify(event).includes('action: kill -TERM')).length, 0,
    'A cancelled final recheck must not log a kill attempt');
  await closeCancelled();
  becomeYoungAfterRead = young = false;
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  const end = startCuChecker(() => false); closeAll.push(end);
  const timer = timers.at(-1)!;
  const beforeHeld = commands.length;
  timer.callback(); timer.callback(); await settle();
  assert.equal(commands.length - beforeHeld, 1, 'Only one check may be in flight');
  release(); await settle(); await end();
  hold = undefined;
  const { collectFamilyOperations } = await import('../../../packages/daemon/src/lib/rpc-handlers/family-operations/index.ts');
  const { registerDriverOperations } = await import('../../../packages/daemon/src/lib/rpc-handlers/family-operations/drivers.ts');
  type Context = Parameters<typeof collectFamilyOperations>[0];
  let settings: { codexCuAutoReap?: boolean } = {};
  const context = {
    deps: { db: { getSession: () => null, getDatabase: () => ({}), getGlobalSettings: () => settings },
      externalEventStore: {}, config: { dbPath: join(run, 'synthetic.db') },
      jobProcessor: { register: () => {} } },
    spaceGoalService: {}, longHorizonAgentRepo: {}, nodeExecutionRepo: {}, spaceTaskRepo: {},
    sessionScheduler: { registerSource: () => {} }, neoPacks: () => [], driverCleanup: closeAll,
  } as unknown as Context;
  for (const value of [undefined, false, true]) {
    settings = value === undefined ? {} : { codexCuAutoReap: value };
    registerDriverOperations(context);
    const registered = timers.at(-1)!;
    const beforeSignals = signals.length, beforeNotices = notices.length;
    registered.callback(); await settle();
    assert.equal(signals.length - beforeSignals, value === false ? 0 : 1,
      'Omitted setting must auto-reap; only explicit false opts out');
    assert.equal(notices.length - beforeNotices, value === false ? 1 : 0);
    await closeAll.at(-1)!();
  }
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const beforeNonMac = timers.length;
  await startCuChecker(() => true)();
  assert.equal(timers.length, beforeNonMac);
  assert(events.length > 0, 'Automatic actions, opt-out alerts and refusals must be logged');
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ pass: true, notices, signals, commands, timers: timers.map(({ callback: _callback, ...timer }) => timer), events, realMachineProof: 'not covered by this synthetic helper' }, null, 2));
  process.stdout.write('PASS: synthetic macOS command adapter, automatic default, opt-out alert, reread, failures, cadence, overlap and cleanup\n');
} finally {
  for (const close of closeAll) await close();
  unsubscribe(); kill.mockRestore(); interval.mockRestore(); clear.mockRestore();
  Object.defineProperty(process, 'platform', platform);
  mock.restore();
}
