import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  NEO_PACK_CODING_INSTRUCTIONS,
  NEO_PACK_DELEGATION_INSTRUCTIONS,
  NEO_PACK_COMPUTER_USE_INSTRUCTIONS,
  NEO_PACK_SKILLS,
} from '@hyperneo/prompts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import { NEO_DEFAULT_PACKS, neoPackBriefs, neoPacks } from '../../../../src/lib/neo/packs/index.ts';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';
import { chooseLine } from '../../../../src/lib/neo/pack-selection.ts';
import { validatePackPreference } from '../../../../src/lib/neo/preference-operations.ts';
import { DELEGATION_PACK_BRIEF } from '../../../../src/lib/neo/packs/delegation/pack.ts';
import { COMPUTER_USE_PACK_BRIEF } from '../../../../src/lib/neo/packs/computer-use/pack.ts';

const pack = (id: string, describe = id): NeoPack => ({ id, describe, instructions: () => null });

describe('neoPackBriefs', () => {
  test('lists the enabled built-in packs by default', () => {
    expect(neoPackBriefs(NEO_DEFAULT_PACKS)).toEqual([
      {
        id: 'coding',
        describe:
          'Software work in git repositories: pull requests, CI, review and merging. Check pr_approved {url} waits for saved-policy approval; pr_merged waits for merge. Multi-PR work uses one PR per todo, chained with after; name each opened PR with neo.todo.edit addUrls.',
        skill: 'coding-pack',
      },
      DELEGATION_PACK_BRIEF,
      COMPUTER_USE_PACK_BRIEF,
    ]);
  });

  test('ships the coding pack as a skill whose body is the pack instructions', () => {
    const briefs = neoPackBriefs(NEO_DEFAULT_PACKS);
    expect(briefs.map((brief) => brief.skill)).toEqual(['coding-pack', undefined, undefined]);
    expect(briefs[0].guidance).toBeUndefined();
    expect(Object.keys(NEO_PACK_SKILLS)).toEqual(['coding-pack']);
    for (const [name, skill] of Object.entries(NEO_PACK_SKILLS)) {
      expect(skill.name).toBe(name);
      expect(skill.description).not.toContain('\n');
      expect(skill.description).not.toContain(': ');
      expect(Object.keys(skill.files)).toEqual(['SKILL.md']);
      expect(skill.files['SKILL.md']).toStartWith(`---\nname: ${name}\ndescription: `);
    }
    expect(NEO_PACK_SKILLS['coding-pack'].body).toBe(NEO_PACK_CODING_INSTRUCTIONS);
  });

  test('keeps coding guidance out of the Neo system prompt and delegation in it', () => {
    const prompt = neoPrompt(neoPackBriefs(NEO_DEFAULT_PACKS));
    expect(prompt).not.toContain(NEO_PACK_CODING_INSTRUCTIONS.slice(0, 80));
    expect(prompt).not.toContain('Guidance for work under the coding pack');
    expect(prompt).toContain(NEO_PACK_DELEGATION_INSTRUCTIONS);
    expect(prompt).toContain(NEO_PACK_COMPUTER_USE_INSTRUCTIONS);
    expect(prompt).toContain('coding — Software work in git repositories');
    expect(prompt).toContain('load its guidance skill: coding-pack.');
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

const lineA = { provider: 'anthropic', model: 'a' };
const lineB = { provider: 'openai', model: 'b', harness: 'codex', effort: 'high' };

describe('chooseLine', () => {
  test('passes the candidates through in order when no pack ranks them', async () => {
    expect(await chooseLine([pack('coding')], 'coding.write', [lineB, lineA], {})).toEqual({
      ranked: [{ line: lineB }, { line: lineA }],
      skipped: [],
      exhausted: false,
    });
  });

  test("returns the ranking pack's answer for the kind, candidates and scope", async () => {
    const calls: unknown[] = [];
    const ranking = { ranked: [{ line: lineA }], skipped: [{ line: lineB, reason: 'held' }] };
    const ranker: NeoPack = {
      ...pack('model-routing'),
      rankLines: (...args) => {
        calls.push(args);
        return { ...ranking, exhausted: false };
      },
    };
    const scope = { repo: 'org/app' };
    expect(
      await chooseLine([pack('coding'), ranker], 'coding.review', [lineB, lineA], scope)
    ).toEqual({ ...ranking, exhausted: false });
    expect(calls).toEqual([['coding.review', [lineB, lineA], scope]]);
  });
});

describe('validatePackPreference', () => {
  const declares = (kind: 'routes' | 'lineRules' | 'holdRules'): NeoPack => ({
    ...pack('model-routing'),
    preferences: {
      value: {
        label: { en: kind, 'zh-Hans': kind },
        valueLabels: {},
        scope: 'global',
        type: { kind },
        default: [],
        ask: kind,
      },
    },
  });
  test.each<[string, 'routes' | 'lineRules' | 'holdRules', unknown, boolean]>([
    [
      'routes for a kind and a repo',
      'routes',
      [
        { kind: 'coding.write', lines: [lineA, lineB] },
        { kind: 'coding.write', repos: ['org/app'], lines: [{ ...lineB, stopAtPercent: 90 }] },
      ],
      true,
    ],
    ['a route with no lines', 'routes', [{ kind: 'coding.write', lines: [] }], false],
    [
      'stopAtPercent above 100',
      'routes',
      [{ kind: 'coding.write', lines: [{ ...lineA, stopAtPercent: 120 }] }],
      false,
    ],
    [
      'a route repo that is not owner/name',
      'routes',
      [{ kind: 'k', repos: ['app'], lines: [lineA] }],
      false,
    ],
    [
      'only and never filters',
      'lineRules',
      [
        { line: lineA, only: { kinds: ['coding.review'] } },
        { line: lineA, only: { kinds: ['coding.write'], repos: ['org/tools'] } },
        { line: lineB, never: { kinds: ['coding.write'], projects: ['p1'] } },
      ],
      true,
    ],
    ['an unknown filter dimension', 'lineRules', [{ line: lineA, only: { teams: ['x'] } }], false],
    ['a line without a model', 'lineRules', [{ line: { provider: 'anthropic' } }], false],
    [
      'hold rules with and without a line',
      'holdRules',
      [
        { reason: 'limit', line: lineA, action: 'move', afterMinutes: 0 },
        { reason: 'overloaded', action: 'wait', afterMinutes: 30 },
      ],
      true,
    ],
    [
      'an unknown hold reason',
      'holdRules',
      [{ reason: 'quota', action: 'move', afterMinutes: 5 }],
      false,
    ],
    [
      'an unknown action',
      'holdRules',
      [{ reason: 'limit', action: 'switch', afterMinutes: 5 }],
      false,
    ],
    [
      'negative minutes',
      'holdRules',
      [{ reason: 'login', action: 'move', afterMinutes: -1 }],
      false,
    ],
  ])('%s', (_label, kind, value, valid) => {
    const result = validatePackPreference(
      { pack: 'model-routing', scope: { kind: 'global', key: '' }, key: 'value', value },
      [declares(kind)]
    );
    expect('value' in result).toBe(valid);
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
