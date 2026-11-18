import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { countPipelineRoutes } from './system-map.ts';

test('task message sends enter their named pipeline', () => {
  const path = 'packages/daemon/src/lib/messaging/task-message-send.ts';
  const source = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const counts = countPipelineRoutes(new Map([[path, source]]));
  expect(counts).toEqual({ missing: 0, misnamed: 0, dynamic: 0, unreadable: 0 });
});
