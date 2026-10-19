import { describe, expect, test } from 'bun:test';
import {
  NEO_BUILTIN_PACK_BRIEFS,
  NEO_DEFAULT_PACKS,
  neoPackBriefs,
} from '../../../../src/lib/neo/packs/index.ts';

describe('life-admin brief', () => {
  test('is a built-in that stays disabled unless the settings name it', () => {
    expect(NEO_BUILTIN_PACK_BRIEFS.map((brief) => brief.id)).toEqual(['coding', 'life-admin']);
    expect(neoPackBriefs(NEO_DEFAULT_PACKS).map((brief) => brief.id)).toEqual(['coding']);
    expect(neoPackBriefs(['coding', 'life-admin']).map((brief) => brief.id)).toEqual([
      'coding',
      'life-admin',
    ]);
  });
});
