import { accessSync, constants } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnProcess, type SpawnFn } from '@hyperneo/daemon/lib/runtime-spawn';

export const SERVICE_LABEL = 'ai.hyperneo.daemon';
const USAGE =
  'Usage: hyperneo service install [--host <addr>] [--port <port>] | hyperneo service uninstall | hyperneo service status';

type ServicePlan =
  | { action: 'install'; host?: string; port?: string }
  | { action: 'uninstall' }
  | { action: 'status' };

export function planService(args: string[]): ServicePlan | { reason: string } {
  const [action, ...flags] = args;
  if ((action === 'uninstall' || action === 'status') && !flags.length) return { action };
  if (action !== 'install') return { reason: USAGE };
  const plan: { action: 'install'; host?: string; port?: string } = { action };
  for (let i = 0; i < flags.length; i += 2) {
    const [flag, value] = [flags[i], flags[i + 1]];
    if (!value || value.startsWith('-')) return { reason: USAGE };
    if (flag === '--host') plan.host = value;
    else if (flag === '--port' && /^\d{1,5}$/.test(value) && Number(value) <= 65535)
      plan.port = value;
    else return { reason: USAGE };
  }
  return plan;
}

export function serviceProgram(
  execPath: string,
  moduleUrl: string,
  mainPath: string
): { program: string[]; env: Record<string, string> } {
  return moduleUrl.includes('/$bunfs/root/')
    ? { program: [execPath], env: {} }
    : { program: [execPath, mainPath], env: { NODE_ENV: 'production' } };
}

const xml = (value: string) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function servicePlist(options: {
  program: string[];
  env: Record<string, string>;
  home: string;
  workingDirectory: string;
}): string {
  const logs = join(options.home, '.hyperneo', 'logs');
  const args = options.program.map((arg) => `    <string>${xml(arg)}</string>`).join('\n');
  const env = Object.entries({ HOME: options.home, ...options.env })
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(options.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(join(logs, 'service.out.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(logs, 'service.err.log'))}</string>
</dict>
</plist>
`;
}

interface ServiceDeps {
  spawn: SpawnFn;
  home: string;
  uid: number;
  execPath: string;
  moduleUrl: string;
  mainPath: string;
  path: string | undefined;
  print(text: string): void;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export function stableBun(execPath: string, path: string | undefined): string {
  for (const dir of (path ?? '').split(':')) {
    if (!dir) continue;
    try {
      accessSync(join(dir, 'bun'), constants.X_OK);
      return join(dir, 'bun');
    } catch {}
  }
  return execPath;
}

const defaultDeps = (): ServiceDeps => ({
  spawn: spawnProcess,
  home: homedir(),
  uid: process.getuid?.() ?? 0,
  execPath: process.execPath,
  moduleUrl: import.meta.url,
  mainPath: resolve(import.meta.dir, '../main.ts'),
  path: process.env.PATH,
  print: (text) => console.log(text),
  write: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, { mode: 0o644 });
  },
  remove: (path) => rm(path, { force: true }),
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
});

async function launchctl(deps: ServiceDeps, args: string[]) {
  const child = deps.spawn(['/bin/launchctl', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, text: `${out}${err}`.trim() };
}

export async function runService(
  args: string[],
  deps: ServiceDeps = defaultDeps()
): Promise<number> {
  const plan = planService(args);
  if ('reason' in plan) {
    deps.print(plan.reason);
    return 1;
  }
  const domain = `gui/${deps.uid}`;
  const target = `${domain}/${SERVICE_LABEL}`;
  const plistPath = join(deps.home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  if (plan.action === 'status') {
    const { code, text } = await launchctl(deps, ['print', target]);
    const pid = /^\s*pid = (\d+)/m.exec(text)?.[1];
    deps.print(code === 0 ? `loaded${pid ? `, pid ${pid}` : ', not running'}` : 'not installed');
    return code === 0 ? 0 : 1;
  }
  await launchctl(deps, ['bootout', target]);
  for (let i = 0; i < 50 && (await launchctl(deps, ['print', target])).code === 0; i++)
    await deps.sleep(200);
  if (plan.action === 'uninstall') {
    await deps.remove(plistPath);
    deps.print(`Removed ${SERVICE_LABEL}.`);
    return 0;
  }
  const { program, env } = serviceProgram(
    deps.moduleUrl.includes('/$bunfs/root/') ? deps.execPath : stableBun(deps.execPath, deps.path),
    deps.moduleUrl,
    deps.mainPath
  );
  const flags = [
    ...(plan.host ? ['--host', plan.host] : []),
    ...(plan.port ? ['--port', plan.port] : []),
  ];
  await deps.write(
    plistPath,
    servicePlist({
      program: [...program, ...flags],
      env: deps.path ? { ...env, PATH: deps.path } : env,
      home: deps.home,
      workingDirectory: env.NODE_ENV ? resolve(deps.mainPath, '../../..') : deps.home,
    })
  );
  const loaded = await launchctl(deps, ['bootstrap', domain, plistPath]);
  if (loaded.code !== 0) {
    deps.print(`launchctl bootstrap failed: ${loaded.text}`);
    return 1;
  }
  deps.print(
    `Installed ${SERVICE_LABEL}. It starts at login and restarts if it exits. Logs: ~/.hyperneo/logs/service.*.log`
  );
  return 0;
}
