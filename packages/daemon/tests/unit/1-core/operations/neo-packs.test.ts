import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  NEO_PACK_CODING_INSTRUCTIONS,
  NEO_PACK_DELEGATION_INSTRUCTIONS,
  NEO_PACK_SKILLS,
} from '@hyperneo/prompts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import { NEO_DEFAULT_PACKS, neoPackBriefs, neoPacks } from '../../../../src/lib/neo/packs/index.ts';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';
import { DELEGATION_PACK_BRIEF } from '../../../../src/lib/neo/packs/delegation/pack.ts';

const pack = (id: string, describe = id): NeoPack => ({ id, describe, instructions: () => null });

describe('neoPackBriefs', () => {
  test('lists the enabled built-in packs by default', () => {
    expect(neoPackBriefs(NEO_DEFAULT_PACKS)).toEqual([
      {
        id: 'coding',
        describe:
          'Software work in git repositories: pull requests, CI, review and merging. Check pr_approved {url} waits for saved-policy approval; pr_merged waits for merge.',
        skill: 'coding-pack',
      },
      DELEGATION_PACK_BRIEF,
    ]);
  });

  test('ships the default packs as skills whose bodies are the pack instructions', () => {
    const briefs = neoPackBriefs(NEO_DEFAULT_PACKS);
    expect(briefs.map((brief) => brief.skill)).toEqual(['coding-pack', 'delegation-pack']);
    expect(briefs.every((brief) => brief.guidance === undefined)).toBe(true);
    expect(Object.keys(NEO_PACK_SKILLS)).toEqual(['coding-pack', 'delegation-pack']);
    for (const [name, skill] of Object.entries(NEO_PACK_SKILLS)) {
      expect(skill.name).toBe(name);
      expect(skill.description).not.toContain('\n');
      expect(skill.description).not.toContain(': ');
      expect(Object.keys(skill.files)).toEqual(['SKILL.md']);
      expect(skill.files['SKILL.md']).toStartWith(`---\nname: ${name}\ndescription: `);
    }
    expect(NEO_PACK_SKILLS['coding-pack'].body).toBe(NEO_PACK_CODING_INSTRUCTIONS);
    expect(NEO_PACK_SKILLS['delegation-pack'].body).toBe(NEO_PACK_DELEGATION_INSTRUCTIONS);
  });

  test('keeps skill pack guidance out of the Neo system prompt', () => {
    const prompt = neoPrompt(neoPackBriefs(NEO_DEFAULT_PACKS));
    expect(prompt).not.toContain(NEO_PACK_CODING_INSTRUCTIONS.slice(0, 80));
    expect(prompt).not.toContain(NEO_PACK_DELEGATION_INSTRUCTIONS.slice(0, 80));
    expect(prompt).not.toContain('Guidance for work under the');
    expect(prompt).toContain('coding — Software work in git repositories');
    expect(prompt).toContain('skills coding-pack, delegation-pack');
  });

  test('publishes approval checks for both todos and question retirement in the coding guidance', () => {
    const guidance = NEO_PACK_CODING_INSTRUCTIONS.replace(/\s+/g, ' ');
    expect(guidance).toContain('kind:"pr_approved",params:{url:');
    expect(guidance).toContain('neo.todo.add check or neo.question.ask retireWhen');
    expect(guidance).toContain('human never passes automatically');
  });

  test('keeps only installed packs the enable list names', () => {
    const briefs = neoPackBriefs(['coding', 'legal-review'], [{ id: 'coding', describe: 'code' }]);
    expect(briefs.map((brief) => brief.id)).toEqual(['coding']);
  });

  test('requires review approval before a manual merge and forbids auto-merge', () => {
    const guidance = NEO_PACK_CODING_INSTRUCTIONS.replace(/\s+/g, ' ');
    expect(guidance).toContain('Never enable GitHub auto-merge');
    expect(guidance).toContain(
      'For owner execution, merge by hand after the required review approves the latest head and required checks are green'
    );
    expect(guidance).toContain('Do not chase owners to merge in daemon repos');
    expect(guidance).toContain('call neo.coding.merge.human');
    expect(guidance).toContain('enabled:true to add human-merge; use enabled:false');
  });

  test('asks the human how a new repository is reviewed and creates its verify skill first', () => {
    const guidance = NEO_PACK_CODING_INSTRUCTIONS.replace(/\s+/g, ' ');
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
