import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import { describe, expect, test } from 'bun:test';
import {
  loadNeoFilePacks,
  loadNeoPackSkill,
  neoPackIds,
  parseNeoPackSkill,
  requireNeoPackFolderName,
  requireNeoPackSkillStatic,
} from '../../../../src/lib/neo/packs/file-packs.ts';
import {
  adoptNeoFilePacks,
  NEO_DEFAULT_PACKS,
  neoEnabledPacks,
  neoSettingsPackBriefs,
} from '../../../../src/lib/neo/packs/index.ts';

const skill = (name = 'inbox-triage', description = 'Inbox, calendar and orders.'): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nFile the inbox daily.\n`;

describe('parseNeoPackSkill', () => {
  test('reads name, description and body from the frontmatter', () => {
    expect(parseNeoPackSkill(skill())).toEqual({
      value: {
        name: 'inbox-triage',
        description: 'Inbox, calendar and orders.',
        body: 'File the inbox daily.',
      },
    });
    expect(parseNeoPackSkill('---\nname: "quoted"\ndescription: "Quoted desc"\n---\nBody')).toEqual(
      {
        value: { name: 'quoted', description: 'Quoted desc', body: 'Body' },
      }
    );
    expect(parseNeoPackSkill(skill().replace(/\r?\n/g, '\r\n'))).toEqual({
      value: expect.objectContaining({ name: 'inbox-triage' }),
    });
  });

  test.each<[string, string, string]>([
    ['no frontmatter', 'Just a body.', 'needs a frontmatter block'],
    ['a name that is not a pack id', skill('Life_Admin'), 'kebab-case pack id'],
    ['no description', skill('inbox-triage', ''), 'one non-empty line'],
    ['no body', '---\nname: inbox-triage\ndescription: Desc\n---\n\n', 'no instructions'],
  ])('refuses %s', (_label, markdown, message) => {
    expect(parseNeoPackSkill(markdown)).toEqual({ reason: expect.stringContaining(message) });
  });
});

describe('requireNeoPackSkillStatic', () => {
  const parsed = parseNeoPackSkill(skill()).value!;
  test.each<[string, ReturnType<typeof parseNeoPackSkill>]>([
    ['a static body', { value: parsed }],
    ['a templated body', { value: { ...parsed, body: 'Hello {{user}}' } }],
    ['a templated description', { value: { ...parsed, description: 'For {{user}}' } }],
  ])('refuses %s', (label, input) => {
    const checked = requireNeoPackSkillStatic(input.value);
    expect(checked).toEqual(
      label === 'a static body' ? { value: parsed } : { reason: expect.stringContaining('{{') }
    );
  });
});

describe('requireNeoPackFolderName', () => {
  const parsed = parseNeoPackSkill(skill()).value!;
  test('accepts a folder matching the pack id and refuses any other', () => {
    expect(requireNeoPackFolderName('inbox-triage', parsed)).toEqual({ value: parsed });
    expect(requireNeoPackFolderName('admin', parsed)).toEqual({
      reason: expect.stringContaining('must match'),
    });
  });
});

describe('loadNeoPackSkill', () => {
  test('loads a pack whose folder matches its SKILL.md', () => {
    const files = new Map([['inbox-triage/SKILL.md', skill()]]);
    expect(loadNeoPackSkill('inbox-triage', '', (file) => files.get(file)!)).toEqual({
      id: 'inbox-triage',
      describe: 'Inbox, calendar and orders.',
      instructions: expect.any(Function),
    });
  });

  test('returns the gate reason without loading', () => {
    const files = new Map([['admin/SKILL.md', skill()]]);
    expect(loadNeoPackSkill('admin', '', (file) => files.get(file)!)).toEqual(
      expect.stringContaining('must match')
    );
    expect(() =>
      loadNeoPackSkill('gone', '', () => {
        throw new Error('ENOENT');
      })
    ).toThrow('ENOENT');
  });
});

describe('loadNeoFilePacks', () => {
  const folders = (entries: Record<string, string>) => (file: string) => {
    const body = entries[file.split('/').at(-2)!];
    if (body === undefined) throw new Error(`ENOENT: ${file}`);
    return body;
  };

  test('loads every valid folder and skips invalid or non-pack entries', () => {
    const warned: [string, unknown][] = [];
    const packs = loadNeoFilePacks({
      root: '/packs',
      read: folders({
        'inbox-triage': skill(),
        Notes: skill('notes'),
        broken: 'no frontmatter',
        'pack-2': skill('pack-2'),
      }),
      list: () => ['inbox-triage', 'Notes', 'broken', 'pack-2'],
      warn: (id, error) => warned.push([id, error]),
    });
    expect(packs.map((pack) => pack.id)).toEqual(['inbox-triage', 'pack-2']);
    expect(packs[0].instructions()).toBe('File the inbox daily.');
    expect(warned.map(([id]) => id)).toEqual(['broken']);
  });

  test('a file pack id a built-in owns is refused at load', () => {
    const warned: [string, unknown][] = [];
    const packs = loadNeoFilePacks({
      root: '/packs',
      read: folders({
        coding: skill('coding'),
        'life-admin': skill('life-admin'),
        core: skill('core'),
      }),
      list: () => ['coding', 'life-admin', 'core'],
      warn: (id, error) => warned.push([id, error]),
    });
    expect(packs).toEqual([]);
    expect(warned.map(([id]) => id)).toEqual(['coding', 'life-admin', 'core']);
    expect((warned[0][1] as Error).message).toContain('reserved by a built-in pack');
  });

  test('an unreadable root is no packs at all', () => {
    expect(
      loadNeoFilePacks({
        root: '/gone',
        list: () => {
          throw new Error('ENOENT');
        },
      })
    ).toEqual([]);
  });
});

describe('neoEnabledPacks', () => {
  test('defaults to coding and follows the settings list', () => {
    expect(neoEnabledPacks()).toEqual(NEO_DEFAULT_PACKS);
    expect(neoEnabledPacks({ packs: [] })).toEqual([]);
    expect(neoEnabledPacks({ packs: ['coding', 'inbox-triage'] })).toEqual([
      'coding',
      'inbox-triage',
    ]);
  });
});

describe('neoSettingsPackBriefs', () => {
  test('enabled file pack briefs join the built-ins once adopted', () => {
    adoptNeoFilePacks([]);
    expect(neoSettingsPackBriefs()).toEqual([
      {
        id: 'coding',
        describe: 'Software work in git repositories: pull requests, CI, review and merging.',
        guidance: NEO_PACK_CODING_INSTRUCTIONS,
      },
    ]);
    adoptNeoFilePacks(
      loadNeoFilePacks({
        root: '',
        read: () => skill('inbox-triage'),
        list: () => ['inbox-triage'],
      })
    );
    expect(neoSettingsPackBriefs({ packs: ['inbox-triage'] }).map((brief) => brief.id)).toEqual([
      'inbox-triage',
    ]);
    expect(neoSettingsPackBriefs().map((brief) => brief.id)).toEqual(['coding']);
    adoptNeoFilePacks([]);
  });
});

describe('neoPackIds', () => {
  test('keeps only kebab-case folder names', () => {
    expect(neoPackIds(['inbox-triage', 'Notes', 'a', 'pack-2', 'x_1'])).toEqual([
      'a',
      'inbox-triage',
      'pack-2',
    ]);
  });
});
