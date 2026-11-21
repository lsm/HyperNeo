import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { exerciseCodexSetupHost } from '../../../packages/daemon/tests/fixtures/codex-setup-host.ts';

const run = resolve(process.argv.at(-1)!);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
assert.equal(process.env.OPENAI_API_KEY, undefined);
assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
console.log(JSON.stringify(await exerciseCodexSetupHost(join(run, 'home'))));
