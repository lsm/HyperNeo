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
let numericTimers = false;
let hold: Promise<void> | undefined;
const commands: { file: string; args: string[] }[] = [];
const notices: string[] = [];
const signals: { pid: number; signal: string }[] = [];
const timers: { callback: () => void; delay: number; unref: boolean; cleared: boolean }[] = [];
const events: unknown[] = [];
let closeOnAction: (() => Promise<void>) | undefined;
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
  return numericTimers ? timers.length : { unref: () => { timer.unref = true; }, timer };
}) as typeof setInterval);
const clear = spyOn(globalThis, 'clearInterval').mockImplementation(((handle: number | { timer: typeof timers[number] }) => {
  (typeof handle === 'number' ? timers[handle - 1] : handle.timer).cleared = true;
}) as typeof clearInterval);
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
Object.defineProperty(process, 'platform', { value: 'darwin' });
const { subscribeToStructuredLogs } = await import('../../../packages/daemon/src/lib/logger.ts');
const unsubscribe = subscribeToStructuredLogs((event) => {
  if (event.module.includes('codex-cu')) {
    events.push(event);
    if (event.message.includes('action: kill -TERM')) void closeOnAction?.();
  }
});
const { startCuChecker } = await import('../../../packages/daemon/src/lib/drivers/codex-cu-reaper.ts');
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise<void>((resolve) => setImmediate(resolve)); };
const closeAll: (() => Promise<void>)[] = [];
try {
  await startCuChecker(() => true)();
  assert.equal(timers.length, 0, 'NODE_ENV=test must not arm the host checker');
  process.env.NODE_ENV = 'production';
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
  for (const automatic of [false, true]) {
    const closeDuringLog = startCuChecker(() => automatic); closeAll.push(closeDuringLog);
    closeOnAction = closeDuringLog;
    const beforeClosedNotices = notices.length, beforeClosedSignals = signals.length;
    try {
      timers.at(-1)!.callback(); await settle();
      assert.equal(notices.length, beforeClosedNotices, 'Close must suppress the pending notification');
      assert.equal(signals.length, beforeClosedSignals, 'Close must suppress the pending signal');
    } finally {
      closeOnAction = undefined;
      await closeDuringLog();
    }
  }
  const beforeIndependentNotices = notices.length, beforeIndependentSignals = signals.length;
  for (let instance = 0; instance < 2; instance++) {
    const closeIndependent = startCuChecker(() => false); closeAll.push(closeIndependent);
    const independentTimer = timers.at(-1)!;
    independentTimer.callback(); await settle(); independentTimer.callback(); await settle();
    await closeIndependent();
  }
  assert.equal(notices.length - beforeIndependentNotices, 2, 'Deduplication belongs to each checker');
  assert.equal(signals.length, beforeIndependentSignals);
  let release!: () => void;
  hold = new Promise<void>((resolve) => { release = resolve; });
  const end = startCuChecker(() => false); closeAll.push(end);
  const timer = timers.at(-1)!;
  const beforeHeld = commands.length;
  timer.callback(); timer.callback(); await settle();
  assert.equal(commands.length - beforeHeld, 1, 'Only one check may be in flight');
  let closedDuringRead = false;
  const closingDuringRead = end().then(() => { closedDuringRead = true; });
  const beforeHeldNotices = notices.length, beforeHeldSignals = signals.length;
  try {
    await settle();
    assert(closedDuringRead, 'Closing must not wait for the held OS command');
  } finally {
    release(); await settle(); await closingDuringRead;
    hold = undefined;
  }
  assert.equal(notices.length, beforeHeldNotices);
  assert.equal(signals.length, beforeHeldSignals);
  const { collectFamilyOperations } = await import('../../../packages/daemon/src/lib/rpc-handlers/family-operations/index.ts');
  const { registerDriverOperations } = await import('../../../packages/daemon/src/lib/rpc-handlers/family-operations/drivers.ts');
  type Context = Parameters<typeof collectFamilyOperations>[0];
  let settings: { codexCuAutoReap?: boolean } = {};
  const context = {
    deps: { db: { getSession: () => null, getDatabase: () => ({}), getGlobalSettings: () => settings },
      externalEventStore: {}, config: { dbPath: join(run, 'synthetic.db') },
      jobQueue: { enqueue: ({ queue }: { queue: string }) => assert.equal(queue, 'work.driver.health') },
      jobProcessor: { register: () => {} } },
    spaceGoalService: {}, longHorizonAgentRepo: {}, nodeExecutionRepo: {}, spaceTaskRepo: {},
    sessionScheduler: { registerSource: () => {} }, neoPacks: () => [], driverCleanup: closeAll,
  } as unknown as Context;
  process.env.NODE_ENV = 'test';
  const beforeTestRegistration = timers.length;
  registerDriverOperations(context);
  assert.equal(timers.length, beforeTestRegistration, 'Test-mode driver registration must not arm CU timers');
  process.env.NODE_ENV = 'production';
  const unownedContext = { ...context };
  delete unownedContext.driverCleanup;
  const unownedBefore = { timers: timers.length, commands: commands.length };
  registerDriverOperations(unownedContext);
  const unownedAfter = { timers: timers.length, commands: commands.length };
  assert.deepEqual(unownedAfter, unownedBefore, 'Absent cleanup must skip checker creation');
  for (const value of [undefined, false, true]) {
    settings = value === undefined ? {} : { codexCuAutoReap: value };
    const cleanupIndex = closeAll.length, timerIndex = timers.length;
    registerDriverOperations(context);
    const registered = timers[timerIndex];
    const beforeSignals = signals.length, beforeNotices = notices.length;
    registered.callback(); await settle();
    assert.equal(signals.length - beforeSignals, value === false ? 0 : 1,
      'Omitted setting must auto-reap; only explicit false opts out');
    assert.equal(notices.length - beforeNotices, value === false ? 1 : 0);
    await closeAll[cleanupIndex]();
    assert(registered.cleared);
  }
  numericTimers = true; settings = {};
  const numericCleanupIndex = closeAll.length, numericTimerIndex = timers.length;
  registerDriverOperations(context);
  const numericTimer = timers[numericTimerIndex];
  const beforeNumericSignals = signals.length;
  numericTimer.callback(); await settle();
  assert.equal(signals.length - beforeNumericSignals, 1);
  await closeAll[numericCleanupIndex]();
  assert(numericTimer.cleared, 'Numeric timer handles must close with the driver');
  Object.defineProperty(process, 'platform', { value: 'linux' });
  const beforeNonMac = timers.length;
  await startCuChecker(() => true)();
  assert.equal(timers.length, beforeNonMac);
  assert(events.length > 0, 'Automatic actions, opt-out alerts and refusals must be logged');
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify({ pass: true, unownedCleanup: { before: unownedBefore, after: unownedAfter }, notices, signals, commands, timers: timers.map(({ callback: _callback, ...timer }) => timer), events, realMachineProof: 'not covered by this synthetic helper' }, null, 2));
  process.stdout.write('PASS: synthetic macOS command adapter, automatic default, opt-out alert, reread, failures, cadence, overlap and cleanup\n');
} finally {
  process.env.NODE_ENV = 'test';
  for (const close of closeAll) await close();
  unsubscribe(); kill.mockRestore(); interval.mockRestore(); clear.mockRestore();
  Object.defineProperty(process, 'platform', platform);
  mock.restore();
}
