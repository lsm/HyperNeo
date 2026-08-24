import { createBunSpawn } from './bun-backend.ts';
import { createNodeSpawn } from './node-backend.ts';
import type { SpawnFn } from './types.ts';

export type { SpawnFn, SpawnOptions, SpawnProcess, SpawnSignal } from './types.ts';

declare const Bun: unknown | undefined;

export const spawnProcess: SpawnFn =
  typeof Bun !== 'undefined' ? createBunSpawn() : createNodeSpawn();
