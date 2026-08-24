import { createBunSpawn } from './bun-backend';
import { createNodeSpawn } from './node-backend';
import type { SpawnFn } from './types';

export type { SpawnFn, SpawnOptions, SpawnProcess, SpawnSignal } from './types';

declare const Bun: unknown | undefined;

export const spawnProcess: SpawnFn =
  typeof Bun !== 'undefined' ? createBunSpawn() : createNodeSpawn();
