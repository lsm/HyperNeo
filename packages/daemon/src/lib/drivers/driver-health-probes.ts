import { execFile } from 'node:child_process';
import { access, open, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import daemonPackage from '../../../package.json' with { type: 'json' };
import { BUILD_METADATA } from '../build-metadata.ts';
import { codexStatePath } from '../../storage/codex-desktop-read.ts';
import { findExecutable } from './find-executable.ts';
import type { WorkAdapter } from './types.ts';
import type { DriverHealth } from '@hyperneo/shared/types/settings';

export const LOCAL_HEALTH_DRIVERS = [
  'hyperneo',
  'codex-desktop',
  'claude-desktop',
  'claude-code',
  'copilot-cli',
] as const;
const execute = promisify(execFile);

async function clientVersions(id: string, home: string): Promise<Record<string, string>> {
  if (id === 'hyperneo') return { daemon: BUILD_METADATA.version };
  if (id === 'codex-desktop' || id === 'claude-desktop') {
    const apps = id === 'codex-desktop' ? ['Codex.app', 'ChatGPT.app'] : ['Claude.app'];
    const plists = [join(home, 'Applications'), '/Applications'].flatMap((applications) =>
      apps.map((app) => join(applications, app, 'Contents', 'Info.plist'))
    );
    for (const plist of plists) {
      try {
        const result = await execute(
          'plutil',
          ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist],
          { timeout: 3000, maxBuffer: 16384 }
        );
        if (result.stdout.trim()) return { desktop: result.stdout.trim() };
      } catch {}
    }
    throw new Error(`${apps.join(' or ')} is not installed or its version cannot be read.`);
  }
  const command = findExecutable(id === 'claude-code' ? 'claude' : 'copilot');
  if (!command) throw new Error(`${id} client is not installed on PATH.`);
  const { stdout } = await execute(command, ['--version'], { timeout: 3000, maxBuffer: 16384 });
  const version = stdout.match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/)?.[0];
  if (!version) throw new Error(`${id} client returned no readable version.`);
  return id === 'copilot-cli'
    ? { cli: version, sdk: daemonPackage.dependencies['@github/copilot-sdk'] }
    : { cli: version };
}

async function sampleTranscript(root: string): Promise<void> {
  const queue = [{ path: root, depth: 0 }];
  let remaining = 128;
  while (queue.length && remaining > 0) {
    const current = queue.shift()!;
    const directory = await opendir(current.path);
    for await (const entry of directory) {
      if (--remaining < 0) break;
      const path = join(current.path, entry.name);
      if (entry.isDirectory() && current.depth < 3) queue.push({ path, depth: current.depth + 1 });
      else if (
        entry.isFile() &&
        (entry.name.endsWith('.jsonl') || /^local_.*\.json$/.test(entry.name))
      ) {
        const file = await open(path, 'r');
        try {
          const data = Buffer.alloc(262144);
          const { bytesRead } = await file.read(data);
          const text = data.subarray(0, bytesRead).toString('utf8');
          const record = entry.name.endsWith('.jsonl') ? text.split('\n')[0] : text;
          if (
            record.trim() &&
            (bytesRead < data.length || (entry.name.endsWith('.jsonl') && text.includes('\n')))
          )
            JSON.parse(record);
        } finally {
          await file.close();
        }
        return;
      }
    }
  }
}

export function createDriverHealthProbe(deps: {
  home: string;
  adapters(): readonly WorkAdapter[];
  versions?: (id: string) => Promise<Record<string, string>>;
}) {
  return async (
    id: string
  ): Promise<Pick<DriverHealth, 'status' | 'reason' | 'clientVersions'>> => {
    let versions: Record<string, string> = {};
    let phase: DriverHealth['status'] = 'unavailable';
    let label = 'Client';
    try {
      versions = await (deps.versions?.(id) ?? clientVersions(id, deps.home));
      const root =
        id === 'codex-desktop'
          ? codexStatePath(deps.home)
          : id === 'claude-code'
            ? join(deps.home, '.claude', 'projects')
            : id === 'claude-desktop'
              ? join(deps.home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
              : undefined;
      label = id === 'codex-desktop' ? 'Codex state database' : 'Driver transcript storage';
      if (root) await access(root);
      phase = 'degraded';
      if (root && id !== 'codex-desktop') await sampleTranscript(root);
      const adapter = deps.adapters().find((adapter) => adapter.id === id);
      if (!adapter)
        return {
          status: 'unavailable',
          reason: `${id} adapter is not registered.`,
          clientVersions: versions,
        };
      await adapter.find({ includeClosed: true, limit: 1 });
      return {
        status: 'ok',
        reason: 'Client version and read-only discovery passed.',
        clientVersions: versions,
      };
    } catch (error) {
      return {
        status: phase,
        reason: `${label}: ${error instanceof Error ? error.message : String(error)}`,
        clientVersions: versions,
      };
    }
  };
}
