import {
  NEO_PACK_COMPUTER_USE_INSTRUCTIONS,
  NEO_PACK_COMPUTER_USE_WORKER,
} from '@hyperneo/prompts';
import type { NeoPack, NeoPackBrief } from '../../pack-contract.ts';

export const COMPUTER_USE_PACK_BRIEF: NeoPackBrief = {
  id: 'computer-use',
  describe: 'How Neo routes steps that need this computer to desktop control.',
  guidance: NEO_PACK_COMPUTER_USE_INSTRUCTIONS,
  alwaysEnabled: true,
};

export function createComputerUsePack(): NeoPack {
  return {
    ...COMPUTER_USE_PACK_BRIEF,
    instructions: () => NEO_PACK_COMPUTER_USE_INSTRUCTIONS,
    workerTemplate: (todo) =>
      todo.desktopApps?.length && todo.named?.desktopControl !== false
        ? 'worker.desktop'
        : undefined,
    workerContext: () => NEO_PACK_COMPUTER_USE_WORKER,
  };
}
