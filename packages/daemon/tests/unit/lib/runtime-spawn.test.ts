import { describe, expect, test } from 'bun:test';
import { createNodeSpawn } from '../../../src/lib/runtime-spawn/node-backend';
import { spawnProcess } from '../../../src/lib/runtime-spawn';
import type { SpawnFn } from '../../../src/lib/runtime-spawn';

async function readStream(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return '';
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

const backends: Array<[string, SpawnFn]> = [
  ['bun', spawnProcess],
  ['node', createNodeSpawn()],
];

for (const [label, spawnImpl] of backends) {
  describe(`runtime-spawn ${label} backend`, () => {
    test('captures stdout, stderr, and exit code', async () => {
      const proc = spawnImpl(['sh', '-c', 'echo out-msg; echo err-msg >&2; exit 3'], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        readStream(proc.stdout),
        readStream(proc.stderr),
        proc.exited,
      ]);
      expect(stdout).toBe('out-msg\n');
      expect(stderr).toBe('err-msg\n');
      expect(exitCode).toBe(3);
      expect(proc.exitCode).toBe(3);
      expect(proc.pid).toBeGreaterThan(0);
    });

    test('passes env and cwd', async () => {
      const proc = spawnImpl(['sh', '-c', 'echo "$SEAM_TEST_VAR"; pwd'], {
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          SEAM_TEST_VAR: 'seam-value',
        },
        cwd: '/tmp',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, exitCode] = await Promise.all([readStream(proc.stdout), proc.exited]);
      const lines = stdout.trim().split('\n');
      expect(lines[0]).toBe('seam-value');
      expect(lines[1]).toBe('/tmp');
      expect(exitCode).toBe(0);
    });

    test('kill terminates a running process with a non-zero exit', async () => {
      const proc = spawnImpl(['sleep', '30'], { stdout: 'pipe', stderr: 'pipe' });
      proc.kill('SIGKILL');
      const exitCode = await proc.exited;
      expect(exitCode).not.toBe(0);
      await readStream(proc.stdout);
      await readStream(proc.stderr);
    });

    test('missing binary fails without hanging', async () => {
      let proc: ReturnType<SpawnFn> | undefined;
      try {
        proc = spawnImpl(['hyperneo-definitely-missing-binary'], { stdout: 'pipe' });
      } catch {
        return;
      }
      const exitCode = await proc.exited;
      expect(exitCode).not.toBe(0);
      expect(await readStream(proc.stdout)).toBe('');
    });
  });
}

describe('runtime-spawn node backend specifics', () => {
  test('stdout ignore yields a null stream', async () => {
    const proc = createNodeSpawn()(['echo', 'silent'], { stdout: 'ignore', stderr: 'pipe' });
    expect(proc.stdout).toBeNull();
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);
  });

  test('detached process groups can be killed via the negative pid', async () => {
    const proc = createNodeSpawn()(['sh', '-c', 'sleep 30'], {
      detached: true,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(proc.pid).toBeGreaterThan(0);
    process.kill(-proc.pid!, 'SIGKILL');
    const exitCode = await proc.exited;
    expect(exitCode).not.toBe(0);
  });
});
