import {
  NEO_PACK_COMPUTER_USE_INSTRUCTIONS,
  NEO_PACK_COMPUTER_USE_WORKER_GUIDANCE,
} from '@hyperneo/prompts';
import type { NeoPack, NeoPackBrief } from '../../pack-contract.ts';
import { DESKTOP_WORKER_TEMPLATE_KEY } from '../../../desktop/worker-profile.ts';

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
        ? DESKTOP_WORKER_TEMPLATE_KEY
        : undefined,
    workerTemplateBrief: (todo) =>
      [
        todo.doneWhen && `Finish when ${todo.doneWhen}`,
        todo.report && `Latest worker report:\n${todo.report}`,
        todo.instruction,
      ]
        .filter(Boolean)
        .join('\n\n'),
    workerContext: () => NEO_PACK_COMPUTER_USE_WORKER_GUIDANCE,
  };
}
