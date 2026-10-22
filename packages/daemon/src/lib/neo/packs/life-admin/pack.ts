import { NEO_PACK_LIFE_ADMIN_INSTRUCTIONS } from '@hyperneo/prompts';
import type { NeoPack, NeoPackBrief } from '../../pack-contract.ts';

export const LIFE_ADMIN_PACK_BRIEF: NeoPackBrief = {
  id: 'life-admin',
  describe:
    'Life admin: inbox, scheduling, orders, bookings, subscriptions, watches. Acts in the user’s own browser and accounts, proves results with confirmations.',
  guidance: NEO_PACK_LIFE_ADMIN_INSTRUCTIONS,
};

export function createLifeAdminPack(): NeoPack {
  return {
    ...LIFE_ADMIN_PACK_BRIEF,
    instructions: () => NEO_PACK_LIFE_ADMIN_INSTRUCTIONS,
  };
}
