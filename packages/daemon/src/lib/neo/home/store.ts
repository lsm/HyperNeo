import type { HomeReadInput, HomeReadResult } from './read.ts';
import type { HomeSavePlan, HomeSaveResult } from './save.ts';

export type HomeResult =
  | { ok: true; path: string; projects: { id: string; homePath: string }[] }
  | { ok: false; reason: string };

export interface NeoHomeStore {
  readonly root: string;
  init(remoteUrl?: string): Promise<HomeResult>;
  read(input: HomeReadInput): Promise<HomeReadResult>;
  save(input: HomeSavePlan): Promise<HomeSaveResult>;
}
