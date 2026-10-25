import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareWorkerSandbox, releaseWorkerSandbox } from '../../../packages/daemon/src/lib/drivers/worker-sandbox.ts';

export async function verifyConcurrentRuntimeRemoval(run: string) {
  await mkdir(join(run, 'evidence'), { recursive: true });
  const root = await mkdtemp(join(run, 'removal-clone-'));
  await mkdir(join(root, '.git'));
  const observations = [];
  try {
    for (let wave = 0; wave < 6; wave++) {
      const env = await prepareWorkerSandbox(root);
      for (let index = 0; index < 24; index++) {
        const path = join(env.TMPDIR, String(index));
        await mkdir(path);
        await writeFile(join(path, 'synthetic'), 'worker bytes');
      }
      const results = await Promise.allSettled([
        releaseWorkerSandbox(root),
        rm(env.TMPDIR, { recursive: true, force: true }),
      ]);
      observations.push({ wave, results: results.map(result => result.status === 'fulfilled'
        ? { ok: true }
        : { ok: false, code: result.reason?.code, error: String(result.reason) }),
        tempReleased: !existsSync(env.TMPDIR), cacheReleased: !existsSync(env.XDG_CACHE_HOME), cloneRetained: existsSync(root) });
      await rm(join(env.TMPDIR, '..'), { recursive: true, force: true });
    }
    await writeFile(join(run, 'evidence/concurrent-runtime-removal.json'), JSON.stringify(observations, null, 2));
    assert(observations.every(wave => wave.results.every(result => result.ok) && wave.tempReleased && wave.cacheReleased && wave.cloneRetained), 'Concurrent filesystem removal must not fail worker runtime release');
  } finally {
    await releaseWorkerSandbox(root);
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await verifyConcurrentRuntimeRemoval(resolve(process.argv[2]));
