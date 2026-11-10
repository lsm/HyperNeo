import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessIdentity } from '../../daemon/src/lib/runtime-process-identity.ts';

const nativeSource = `
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  if (argc != 2) return 1;
  struct proc_bsdinfo info = {0};
  int pid = atoi(argv[1]);
  if (proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != sizeof(info)) return 2;
  printf("%u %u %llu %llu\\n", info.pbi_pid, info.pbi_uid,
    (unsigned long long)info.pbi_start_tvsec, (unsigned long long)info.pbi_start_tvusec);
  return 0;
}
`;

test.skipIf(process.platform !== 'darwin')(
  'native identity matches the SDK struct and ps for a live child, then disappears after exit',
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'process-identity-'));
    const child = spawn('/bin/cat', [], {
      env: { HOME: root, NODE_ENV: 'test', PATH: '/usr/bin:/bin' },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    const exited = once(child, 'exit');
    try {
      const source = join(root, 'identity.c');
      const executable = join(root, 'identity');
      await writeFile(source, nativeSource);
      const compiled = Bun.spawnSync(['/usr/bin/clang', source, '-lproc', '-o', executable]);
      expect(compiled.stderr.toString()).toBe('');
      expect(compiled.exitCode).toBe(0);
      const native = Bun.spawnSync([executable, String(child.pid)]);
      expect(native.exitCode).toBe(0);
      const [pid, uid, seconds, microseconds] = native.stdout
        .toString()
        .trim()
        .split(/\s+/)
        .map(Number);
      expect(pid).toBe(child.pid);
      expect(uid).toBe(process.getuid!());
      expect(seconds).toBeGreaterThan(0);
      expect(microseconds).toBeGreaterThanOrEqual(0);
      expect(microseconds).toBeLessThan(1_000_000);
      const ps = Bun.spawnSync(['/bin/ps', '-p', String(child.pid), '-o', 'lstart='], {
        env: { LC_ALL: 'C', TZ: 'UTC', PATH: '/usr/bin:/bin' },
      });
      expect(ps.exitCode).toBe(0);
      expect(Date.parse(`${ps.stdout.toString().trim()} GMT`) / 1000).toBe(seconds);
      const identities = await Promise.all([
        readProcessIdentity(pid),
        readProcessIdentity(pid),
        readProcessIdentity(pid),
      ]);
      expect(identities).toEqual(Array(3).fill({ seconds, microseconds }));
      child.stdin!.end();
      await exited;
      expect(await readProcessIdentity(pid)).toBeNull();
      console.log('native_identity_children=1 sdk_matches=3 ps_matches=1 exited_null=1');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000
);
