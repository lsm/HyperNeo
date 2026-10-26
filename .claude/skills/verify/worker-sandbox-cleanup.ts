import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareWorkerSandbox, releaseWorkerSandbox } from '../../../packages/daemon/src/lib/drivers/worker-sandbox.ts';
import { workerRuntimeCleanupCommand } from '../../../packages/daemon/src/lib/drivers/worker-runtime-cleanup.ts';

export async function verifyCleanupWriteBoundary(run: string) {
  const fixture = mkdtempSync(join(run, 'cleanup-proof-'));
  const clone = join(fixture, 'clone');
  mkdirSync(join(clone, '.git'), { recursive: true });
  const env = await prepareWorkerSandbox(clone);
  const runtime = join(env.TMPDIR, '..');
  mkdirSync(join(env.TMPDIR, 'swap'));
  const outside = join(fixture, 'outside');
  mkdirSync(join(outside, 'child'), { recursive: true, mode: 0o755 });
  try {
    const args = await workerRuntimeCleanupCommand(runtime);
    args[args.indexOf('/bin/sh') + 2] = `
[ -d "$1/tmp/swap" ] || exit 1
/bin/mv "$1/tmp/swap" "$1/cache/moved" || exit 1
/bin/ln -s "$3" "$1/tmp/swap" || exit 1
/bin/chmod 700 "$1/tmp/swap"
outer=$?
/bin/chmod 700 "$1/tmp/swap/child"
inner=$?
printf inside > "$1/inside"
printf '%s,%s' "$outer" "$inner" > "$1/outside-status"
[ "$outer" -ne 0 ] && [ "$inner" -ne 0 ]
`;
    args.push(outside);
    const result = spawnSync(args[0], args.slice(1), { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
    const observed = {
      exit: result.status,
      insideAllowed: existsSync(join(runtime, 'inside')) && readFileSync(join(runtime, 'inside'), 'utf8') === 'inside',
      outsideRefused: (statSync(outside).mode & 0o777) === 0o755 && (statSync(join(outside, 'child')).mode & 0o777) === 0o755,
      outsideStatus: existsSync(join(runtime, 'outside-status')) ? readFileSync(join(runtime, 'outside-status'), 'utf8') : '',
    };
    writeFileSync(join(run, 'evidence/cleanup-write-boundary.json'), JSON.stringify(observed, null, 2));
    writeFileSync(join(run, 'evidence/cleanup-write-boundary.stderr'), result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert(observed.insideAllowed && observed.outsideRefused);
    assert(/Operation not permitted|Permission denied|Read-only file system/.test(result.stderr), result.stderr);
  } finally {
    await releaseWorkerSandbox(clone);
    rmSync(fixture, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const run = resolve(process.argv[2]);
  mkdirSync(join(run, 'evidence'), { recursive: true });
  await verifyCleanupWriteBoundary(run);
}
