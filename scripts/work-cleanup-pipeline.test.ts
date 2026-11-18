import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { countPipelineRoutes } from './system-map.ts';

test('work cleanup enters its named pipeline', () => {
  const path = 'packages/daemon/src/lib/work-cleanup/runtime.ts';
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  expect(countPipelineRoutes(new Map([[path, source]]))).toEqual({
    missing: 0,
    misnamed: 0,
    dynamic: 0,
    unreadable: 0,
  });
});
