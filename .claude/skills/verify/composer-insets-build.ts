import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const fixtureRequire = createRequire(resolve('packages/web/package.json'));
const result = await Bun.build({ entrypoints: ['.claude/skills/verify/composer-insets.tsx'],
  outdir: 'packages/web/dist/assets', target: 'browser', tsconfig: 'packages/web/tsconfig.json',
  plugins: [{ name: 'fixture-preact', setup(builder) { builder.onResolve({ filter: /^(?:preact(?:\/.*)?|@preact\/signals|react\/jsx-runtime)$/ }, ({ path }) => ({ path: fixtureRequire.resolve(path === 'react/jsx-runtime' ? 'preact/jsx-runtime' : path) })); } }],
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.PROD': 'true', 'import.meta.env.DEV': 'false', 'import.meta.env.MODE': '"production"' },
});
assert(result.success, JSON.stringify(result.logs));
const links = readFileSync('packages/web/dist/neo/index.html', 'utf8').match(/<link rel="stylesheet"[^>]+>/g)?.join('') ?? '';
writeFileSync('packages/web/dist/assets/composer-insets.html', `<html><head><meta name="viewport" content="width=device-width,initial-scale=1">${links}</head><body><div id="root"></div><script type="module" src="/assets/composer-insets.js"></script></body></html>`);
