import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnProcess } from '../../runtime-spawn/index.ts';
import type { SpawnOptions } from '../../runtime-spawn/types.ts';

function quoted(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/\x08/g, '\\b');
}

function configurationEntry(key: string, value: string) {
  const first = key.indexOf('.');
  const last = key.lastIndexOf('.');
  const section = key.slice(0, first);
  const subsection =
    first === last ? '' : ` "${key.slice(first + 1, last).replace(/[\\"]/g, '\\$&')}"`;
  return `[${section}${subsection}]\n${key.slice(last + 1)} = "${quoted(value)}"\n`;
}

export async function spawnHomeCommand(args: string[], options: SpawnOptions, directory: string) {
  const env = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  );
  const versionProbe = spawnProcess(['git', '--version'], {
    cwd: options.cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [version, versionError, versionCode] = await Promise.all([
    new Response(versionProbe.stdout).text(),
    new Response(versionProbe.stderr).text(),
    versionProbe.exited,
  ]);
  if (versionCode) return { failure: { code: versionCode, error: versionError.trim() } };
  const [, major, minor] = version.match(/^git version (\d+)\.(\d+)/) ?? [];
  if (!(Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 32)))
    return {
      failure: {
        code: 1,
        error: `Git 2.32 or newer is required to isolate home filters (found ${version.trim()}).`,
      },
    };
  const probe = spawnProcess(['git', 'config', '--null', '--list', '--show-scope'], {
    cwd: options.cwd,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [output, error, code] = await Promise.all([
    new Response(probe.stdout).text(),
    new Response(probe.stderr).text(),
    probe.exited,
  ]);
  if (code) return { failure: { code, error: `Git configuration: ${error.trim()}` } };
  const entries = output.split('\0');
  const drivers = new Map<string, string>();
  const command: [string, string][] = [];
  let configuration = '';
  for (let index = 0; index + 1 < entries.length; index += 2) {
    const scope = entries[index];
    const entry = entries[index + 1];
    const separator = entry.indexOf('\n');
    const key = separator < 0 ? entry : entry.slice(0, separator);
    const value = separator < 0 ? 'true' : entry.slice(separator + 1);
    if (/^filter\..*\.(clean|smudge|process|required)$/.test(key)) {
      drivers.set(key, key.endsWith('.required') ? 'false' : '');
      continue;
    }
    if (/^merge\..*\.driver$/.test(key)) {
      drivers.set(key, 'git merge-file --marker-size=%L -- %A %O %B');
      continue;
    }
    if (/^diff\..*\.(command|textconv)$/.test(key)) continue;
    if (/^include(?:if)?\./i.test(key)) continue;
    if (scope === 'global' || scope === 'system') configuration += configurationEntry(key, value);
    if (scope === 'command') command.push([key, value]);
  }
  command.push(...drivers);
  const temporary = await mkdtemp(join(directory, '.neo-git-config-'));
  const dispose = () => rm(temporary, { recursive: true, force: true });
  try {
    const path = join(temporary, 'config');
    await writeFile(path, configuration, { mode: 0o600 });
    const child = spawnProcess(args, {
      ...options,
      env: {
        ...env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_SYSTEM: '/dev/null',
        GIT_CONFIG_GLOBAL: path,
        GIT_CONFIG_PARAMETERS: '',
        GIT_CONFIG_COUNT: String(command.length),
        ...Object.fromEntries(
          command.flatMap(([key, value], index) => [
            [`GIT_CONFIG_KEY_${index}`, key],
            [`GIT_CONFIG_VALUE_${index}`, value],
          ])
        ),
      },
    });
    return { child, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
