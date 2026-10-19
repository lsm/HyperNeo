import { describe, expect, test } from 'bun:test';
import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoEvidence } from '../../../../src/lib/neo/evidence.ts';
import { createCodingPack } from '../../../../src/lib/neo/packs/coding/pack.ts';
import { createLifeAdminPack } from '../../../../src/lib/neo/packs/life-admin/pack.ts';
import {
  type NeoPrClaimRow,
  planNeoCardPrCandidates,
} from '../../../../src/lib/neo/packs/coding/card-pr-claims.ts';
import { githubUrlKey } from '../../../../src/lib/github/parse-pr-url.ts';
import type { NeoWorkPrRow } from '../../../../src/lib/neo/packs/coding/neo-work-pr-repository.ts';
import { NEO_DEFAULT_PACKS, neoPackBriefs, neoPacks } from '../../../../src/lib/neo/packs/index.ts';
import type { NeoPack } from '../../../../src/lib/neo/packs/types.ts';

const pack = (id: string, describe = id): NeoPack => ({ id, describe, instructions: () => null });

describe('neoPackBriefs', () => {
  test('lists the enabled built-in packs by default', () => {
    expect(neoPackBriefs(NEO_DEFAULT_PACKS)).toEqual([
      {
        id: 'coding',
        describe: 'Software work in git repositories: pull requests, CI, review and merging.',
        guidance: NEO_PACK_CODING_INSTRUCTIONS,
      },
    ]);
  });

  test('keeps only installed packs the enable list names', () => {
    const briefs = neoPackBriefs(['coding', 'legal-review'], [{ id: 'coding', describe: 'code' }]);
    expect(briefs.map((brief) => brief.id)).toEqual(['coding']);
  });

  test('requires review approval before a manual merge and forbids auto-merge', () => {
    const guidance = neoPackBriefs(NEO_DEFAULT_PACKS)[0].guidance?.replace(/\s+/g, ' ');
    expect(guidance).toContain('never enable GitHub auto-merge');
    expect(guidance).toContain(
      'after the review it uses approves the latest head and required checks are green'
    );
  });

  test('asks the human how a new repository is reviewed and creates its verify skill first', () => {
    const guidance = neoPackBriefs(NEO_DEFAULT_PACKS)[0].guidance?.replace(/\s+/g, ' ');
    expect(guidance).toContain('ask the human once with neo.question.ask (kind choice)');
    expect(guidance).toContain('Never install apps, add reviewers or change repository settings');
    expect(guidance).toContain('target.preparationParameters.verifySkill "create"');
    expect(guidance).toContain('create a Claude Desktop environment for it');
    expect(guidance).toContain("never write Claude Desktop's own files");
  });
});

describe('neoPacks', () => {
  const coding = pack('coding');
  const legal = pack('legal-review');
  test.each<[string, NeoPack[], string[], string[]]>([
    ['the built-in coding pack by default', [], NEO_DEFAULT_PACKS, ['coding']],
    ['a file pack once enabled', [legal], ['coding', 'legal-review'], ['coding', 'legal-review']],
    ['nothing that is not enabled', [legal], ['coding'], ['coding']],
    [
      'the built-in pack over a file pack with its id',
      [pack('coding', 'copy')],
      ['coding'],
      ['coding'],
    ],
  ])('keeps %s', (_label, filePacks, enabled, ids) => {
    const packs = neoPacks({ builtins: [coding], filePacks, enabled });
    expect(packs.map((item) => item.id)).toEqual(ids);
    expect(packs[0]).toBe(coding);
  });
});

const merged: NeoEvidence = {
  key: 'https://github.com/lsm/HyperNeo/pull/1',
  state: 'done',
  summary: 'merged',
  blockers: [],
};
const open: NeoEvidence = {
  ...merged,
  key: 'https://github.com/lsm/HyperNeo/pull/2',
  state: 'pending',
  summary: 'open',
};
const item = (overrides: Partial<NeoAskItem> = {}): NeoAskItem => ({
  id: 'i1',
  text: 'Fix merged to dev',
  state: 'pending',
  evidence: null,
  check: 'coding.pr_merged',
  metBy: null,
  removed: false,
  addedAt: null,
  ...overrides,
});
