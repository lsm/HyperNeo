import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import { NEO_DEFAULT_PACKS, neoPackBriefs, neoPacks } from '../../../../src/lib/neo/packs/index.ts';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';

const pack = (id: string, describe = id): NeoPack => ({ id, describe, instructions: () => null });

describe('neoPackBriefs', () => {
  test('lists the enabled built-in packs by default', () => {
    expect(neoPackBriefs(NEO_DEFAULT_PACKS)).toEqual([
      {
        id: 'coding',
        describe:
          'Software work in git repositories: pull requests, CI, review and merging. Check pr_approved {url} waits for saved-policy approval; pr_merged waits for merge.',
        guidance: NEO_PACK_CODING_INSTRUCTIONS,
      },
    ]);
  });

  test('publishes approval checks for both todos and question retirement in the coding guidance', () => {
    const guidance = neoPackBriefs(NEO_DEFAULT_PACKS)[0].guidance?.replace(/\s+/g, ' ');
    expect(guidance).toContain('kind:"pr_approved",params:{url:');
    expect(guidance).toContain('neo.todo.add check or neo.question.ask retireWhen');
    expect(guidance).toContain('human never passes automatically');
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

describe('core stays pack-agnostic', () => {
  test('no coding pack literal in lib/neo outside packs/ or in the repositories', () => {
    const src = join(import.meta.dirname, '../../../../src');
    const files = [
      ...readdirSync(join(src, 'lib/neo'), { recursive: true })
        .map(String)
        .filter((file) => !file.startsWith('packs/'))
        .map((file) => join(src, 'lib/neo', file)),
      ...readdirSync(join(src, 'storage/repositories')).map((file) =>
        join(src, 'storage/repositories', file)
      ),
    ].filter((file) => file.endsWith('.ts'));
    const offending = files
      .filter((file) => /['"`]coding['"`.]|pr_merged/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(src, file));
    expect(files.length).toBeGreaterThan(20);
    expect(offending).toEqual([]);
  });
});
