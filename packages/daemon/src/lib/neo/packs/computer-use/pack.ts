import superpipe, { type PipelineAPI } from 'superpipe';
import {
  NEO_PACK_COMPUTER_USE_INSTRUCTIONS,
  NEO_PACK_COMPUTER_USE_WORKER,
} from '@hyperneo/prompts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { NeoPack, NeoPackBrief } from '../../pack-contract.ts';
import { desktopControlPreference } from '../../desktop-control-preference.ts';

export const COMPUTER_USE_PACK_BRIEF: NeoPackBrief = {
  id: 'computer-use',
  describe: 'How Neo routes steps that need this computer to desktop control.',
  guidance: NEO_PACK_COMPUTER_USE_INSTRUCTIONS,
  alwaysEnabled: true,
};

const briefing = (superpipe({})('computer-use.briefing') as PipelineAPI)
  .input('preference')
  .pipe(
    (preference: unknown) =>
      `${NEO_PACK_COMPUTER_USE_INSTRUCTIONS}\n\nDesktop control preference (data):\n${JSON.stringify({ desktopControl: preference ?? 'unset' })}`,
    'preference',
    'text'
  )
  .end('text') as (preference: unknown) => string;

export function createComputerUsePack(database: () => Database): NeoPack {
  return {
    ...COMPUTER_USE_PACK_BRIEF,
    instructions: () => briefing(desktopControlPreference(database())),
    workerContext: () => NEO_PACK_COMPUTER_USE_WORKER,
  };
}
