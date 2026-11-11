import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lockCodexSessionName } from '../../../packages/daemon/src/lib/drivers/codex-session-name-lock.ts';
import { spawnProcess } from '../../../packages/daemon/src/lib/runtime-spawn/index.ts';

const [mode, childRun, id] = process.argv.slice(2);
const run = resolve(mode === 'child' ? childRun : mode);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
const state = join(run, 'codex-state');
const project = join(run, 'project');
const namesFile = join(run, 'names.json');
const waitFor = async (path: string) => {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    assert(Date.now() < deadline, `Timed out waiting for ${path}`);
    await new Promise((done) => setTimeout(done, 10));
  }
};
if (mode === 'child') {
  writeFileSync(join(run, `attempting-${id}`), 'yes');
  const release = await lockCodexSessionName(state, project);
  try {
    const names = JSON.parse(readFileSync(namesFile, 'utf8')) as string[];
    let number = 1;
    while (names.includes(`Codex project ${number}`)) number++;
    const title = `Codex project ${number}`;
    writeFileSync(join(run, `selected-${id}`), title);
    if (id === '1') await waitFor(join(run, 'release-first'));
    writeFileSync(namesFile, JSON.stringify([...names, title]));
    console.log(title);
  } finally { release(); }
} else {
  mkdirSync(project, { recursive: true });
  mkdirSync(join(run, 'evidence'), { recursive: true });
  writeFileSync(state, 'Synthetic Codex identity; not a database');
  writeFileSync(namesFile, '[]');
  const launch = (id: string) => spawnProcess([process.execPath, import.meta.filename, 'child', run, id], { stdout: 'pipe', stderr: 'pipe' });
  const first = launch('1');
  let second: ReturnType<typeof launch> | undefined;
  try {
    await waitFor(join(run, 'selected-1'));
    second = launch('2');
    await waitFor(join(run, 'attempting-2'));
    await new Promise((done) => setTimeout(done, 150));
    assert(!existsSync(join(run, 'selected-2')), 'Second process acquired the held naming lock');
    writeFileSync(join(run, 'release-first'), 'yes');
    const statuses = await Promise.all([first.exited, second.exited]);
    assert.deepEqual(statuses, [0, 0]);
    const names = JSON.parse(readFileSync(namesFile, 'utf8'));
    assert.deepEqual(names, ['Codex project 1', 'Codex project 2']);
    writeFileSync(join(run, 'evidence', 'codex-session-name-processes.json'), JSON.stringify({ statuses, names, boundary: 'Two independent Bun processes sharing production lock and synthetic persisted names; no native Codex process' }, null, 2));
  } finally {
    writeFileSync(join(run, 'release-first'), 'yes');
    first.kill(); second?.kill();
    await Promise.all([first.exited, second?.exited]);
  }
}
