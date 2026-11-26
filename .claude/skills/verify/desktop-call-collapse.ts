import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

assert.equal(process.env.NODE_ENV, 'test');
assert(process.argv.includes('--collapse'));

Bun.plugin({
  name: 'desktop-call-collapse-proof',
  setup(build) {
    build.onLoad({ filter: /\/providers\/custom-endpoint-provider\.ts$/ }, async ({ path }) => {
      const source = await readFile(path, 'utf8');
      const flag = /^(const ENABLE_DESKTOP_OBSERVATION_COLLAPSE = )(?:false|true);$/gm;
      assert.equal([...source.matchAll(flag)].length, 1, 'Expected exactly one rollout flag');
      return { contents: source.replace(flag, '$1true;'), loader: 'ts' };
    });
  },
});

await import('./desktop-call.ts');
