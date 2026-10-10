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

const skill = (name = 'life-admin', description = 'Inbox, calendar and orders.'): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nFile the inbox daily.\n`;

describe('parseNeoPackSkill', () => {
  test('reads name, description and body from the frontmatter', () => {
    expect(parseNeoPackSkill(skill())).toEqual({
      value: {
        name: 'life-admin',
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
      value: expect.objectContaining({ name: 'life-admin' }),
    });
  });

  test.each<[string, string, string]>([
    ['no frontmatter', 'Just a body.', 'needs a frontmatter block'],
    ['a name that is not a pack id', skill('Life_Admin'), 'kebab-case pack id'],
    ['no description', skill('life-admin', ''), 'one non-empty line'],
    ['no body', '---\nname: life-admin\ndescription: Desc\n---\n\n', 'no instructions'],
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
    expect(requireNeoPackFolderName('life-admin', parsed)).toEqual({ value: parsed });
    expect(requireNeoPackFolderName('admin', parsed)).toEqual({
      reason: expect.stringContaining('must match'),
    });
  });
});

describe('loadNeoPackSkill', () => {
  test('loads a pack whose folder matches its SKILL.md', () => {
    const files = new Map([['life-admin/SKILL.md', skill()]]);
    expect(loadNeoPackSkill('life-admin', '', (file) => files.get(file)!)).toEqual({
      id: 'life-admin',
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
  const setup = (folders: Record<string, string>) => {
    const warned: [string, unknown][] = [];
    const packs = loadNeoFilePacks({
      root: '/packs',
      read: (file) => {
        const folder = file.split('/').at(-2)!;
        const body = folders[folder];
        if (body === undefined) throw new Error(`ENOENT: ${file}`);
        return body;
      },
      list: () => Object.keys(folders),
      warn: (id, error) => warned.push([id, error]),
    });
    return { packs, warned };
  };

  test('loads every valid folder and skips invalid or non-pack entries', () => {
    const { packs, warned } = setup({
      'life-admin': skill(),
      Notes: skill('notes'),
      broken: 'no frontmatter',
      'pack-2': skill('pack-2'),
    });
    expect(packs.map((pack) => pack.id)).toEqual(['life-admin', 'pack-2']);
    expect(packs[0].instructions(null)).toBe('File the inbox daily.');
    expect(warned.map(([id]) => id)).toEqual(['broken']);
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
    expect(neoEnabledPacks({ packs: ['coding', 'life-admin'] })).toEqual(['coding', 'life-admin']);
  });
});

describe('neoSettingsPackBriefs', () => {
  test('enabled file pack briefs join the built-ins once adopted', () => {
    adoptNeoFilePacks([]);
    expect(neoSettingsPackBriefs()).toEqual([
      {
        id: 'coding',
        describe: 'Software work in git repositories: pull requests, CI, review and merging.',
      },
    ]);
    adoptNeoFilePacks(
      loadNeoFilePacks({
        root: '',
        read: () => skill('life-admin'),
        list: () => ['life-admin'],
      })
    );
    expect(neoSettingsPackBriefs({ packs: ['life-admin'] }).map((brief) => brief.id)).toEqual([
      'life-admin',
    ]);
    expect(neoSettingsPackBriefs().map((brief) => brief.id)).toEqual(['coding']);
    adoptNeoFilePacks([]);
  });
});

describe('neoPackIds', () => {
  test('keeps only kebab-case folder names', () => {
    expect(neoPackIds(['life-admin', 'Notes', 'a', 'pack-2', 'x_1'])).toEqual([
      'a',
      'life-admin',
      'pack-2',
    ]);
  });
});
