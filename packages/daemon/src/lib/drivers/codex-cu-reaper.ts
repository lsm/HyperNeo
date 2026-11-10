import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../logger.ts';

const NAME = 'Codex Computer Use interaction';
const IDLE_MS = 300_000;
const log = new Logger('codex-cu');
const exec = promisify(execFile);
type Observation = Awaited<ReturnType<typeof readObservation>>;

export function decideCuReap(facts: Observation): { pid: number; birth: string }[] {
  if (!facts.assertions.includes('Listed by owning process:')) return [];
  const ages = new Map<number, number[]>();
  for (const line of facts.assertions
    .split('\n')
    .filter((line) => line.includes(NAME) && line.includes('PreventUserIdleDisplaySleep'))) {
    const match = line.match(
      /^\s*pid (\d+)\(([^)]+)\): \[0x[\da-f]+\] (\d+):([0-5]\d):([0-5]\d) PreventUserIdleDisplaySleep named: "Codex Computer Use interaction"\s*$/i
    );
    if (!match) return [];
    if (match[2] !== 'SkyComputerUseService') continue;
    const pid = Number(match[1]);
    ages.set(pid, [
      ...(ages.get(pid) ?? []),
      (Number(match[3]) * 3600 + Number(match[4]) * 60 + Number(match[5])) * 1000,
    ]);
  }
  return facts.processes.split('\n').flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.+)$/);
    if (!match || Number(match[2]) !== facts.uid || match[4] !== facts.path) return [];
    const pid = Number(match[1]),
      birth = match[3];
    const held = ages.get(pid);
    const created = facts.log
      .split('\n')
      .filter(
        (entry) =>
          entry.includes(`PID ${pid}(SkyComputerUseService) Created `) &&
          entry.includes(`"${NAME}"`)
      )
      .map((entry) => Date.parse(entry.slice(0, 25).replace(' ', 'T').replace(' ', '')));
    const last = Math.max(...created);
    return held?.length &&
      held.every((age) => Number.isFinite(age) && age >= IDLE_MS) &&
      Number.isFinite(last) &&
      last >= Date.parse(birth) &&
      facts.now - last >= IDLE_MS
      ? [{ pid, birth }]
      : [];
  });
}

async function command(file: string, args: string[]) {
  return (
    await exec(file, args, {
      timeout: 10_000,
      killSignal: 'SIGTERM',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
    })
  ).stdout;
}

async function readObservation() {
  const assertions = await command('/usr/bin/pmset', ['-g', 'assertions']);
  const facts = {
    now: Date.now(),
    path: join(
      homedir(),
      '.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService'
    ),
    uid: process.getuid!(),
    assertions,
    log: '',
    processes: '',
  };
  if (!assertions.includes(NAME)) return facts;
  facts.log = await command('/usr/bin/pmset', ['-g', 'log']);
  facts.processes = await command('/bin/ps', ['-axo', 'pid=,uid=,lstart=,comm=']);
  return { ...facts, now: Date.now() };
}

type Effects = {
  read(): Promise<Observation>;
  auto(): boolean;
  notify(text: string): Promise<void>;
  signal(pid: number): void;
};

export function createCuChecker(effects: Effects) {
  const seen = new Set<string>();
  let checking: Promise<void> | undefined;
  let closed = false;
  const check = () =>
    (checking ??= (async () => {
      if (closed) return;
      for (const candidate of decideCuReap(await effects.read())) {
        const auto = effects.auto(),
          key = `${candidate.pid}:${candidate.birth}:${auto}`;
        if (closed || seen.has(key)) continue;
        const text = `Computer Use display-sleep assertion leak; action: kill -TERM ${candidate.pid} (SkyComputerUseService only).`;
        if (auto) {
          if (
            !decideCuReap(await effects.read()).some(
              (next) => next.pid === candidate.pid && next.birth === candidate.birth
            ) ||
            !effects.auto() ||
            closed
          )
            continue;
          seen.add(key);
          log.warn(text, { automatic: true });
          if (!closed) effects.signal(candidate.pid);
        } else {
          seen.add(key);
          log.warn(text, { automatic: false });
          if (!closed) await effects.notify(text);
        }
      }
    })()
      .catch((error) => log.warn('Computer Use assertion check skipped', { error: String(error) }))
      .finally(() => {
        checking = undefined;
      }));
  const timer = setInterval(() => void check(), 60_000);
  timer.unref?.();
  return {
    check,
    close: async () => {
      closed = true;
      clearInterval(timer);
    },
  };
}

export function startCuChecker(auto: () => boolean) {
  if (process.platform !== 'darwin' || process.env.NODE_ENV === 'test') return async () => {};
  return createCuChecker({
    read: readObservation,
    auto,
    signal: (pid) => process.kill(pid, 'SIGTERM'),
    notify: async (text) => {
      await command('/usr/bin/osascript', [
        '-e',
        'on run argv\ndisplay notification (item 1 of argv) with title "Codex Computer Use"\nend run',
        text,
      ]);
    },
  }).close;
}
