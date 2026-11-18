import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { countPipelineRoutes } from './system-map.ts';

test.each([
  'packages/daemon/src/lib/artifacts/live-file-read.ts',
  'packages/daemon/src/lib/handoffs/card-read.ts',
])('the file reader enters its named pipeline: %s', (path) => {
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  expect(countPipelineRoutes(new Map([[path, source]]))).toEqual({
    missing: 0,
    misnamed: 0,
    dynamic: 0,
    unreadable: 0,
  });
});
