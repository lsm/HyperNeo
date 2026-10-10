import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoPack } from './types.ts';

export interface NeoPackSkill {
  name: string;
  description: string;
  body: string;
}

type SkillGate = { value: NeoPackSkill } | { reason: string };

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
const PACK_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PLACEHOLDER = /\{\{[^}]*\}\}/;

export function parseNeoPackSkill(markdown: string): SkillGate {
  const match = FRONTMATTER.exec(markdown.replace(/\r\n/g, '\n'));
  if (!match) return { reason: 'SKILL.md needs a frontmatter block with name and description.' };
  const field = (key: string) =>
    new RegExp(`^${key}:[ \\t]*(.+?)[ \\t]*$`, 'm')
      .exec(match[1])?.[1]
      ?.replace(/^(['"])(.*)\1$/, '$2');
  const name = field('name');
  const description = field('description');
  if (typeof name !== 'string' || !PACK_ID.test(name))
    return { reason: 'SKILL.md name must be a kebab-case pack id.' };
  if (typeof description !== 'string' || !description.trim())
    return { reason: 'SKILL.md description must be one non-empty line.' };
  const body = match[2].trim();
  if (!body) return { reason: 'SKILL.md has no instructions.' };
  return { value: { name, description: description.trim(), body } };
}

export function requireNeoPackSkillStatic(skill: NeoPackSkill): SkillGate {
  return PLACEHOLDER.test(skill.body) || PLACEHOLDER.test(skill.description)
    ? { reason: 'File packs are static: remove {{…}} placeholders.' }
    : { value: skill };
}

export function requireNeoPackFolderName(folder: string, skill: NeoPackSkill): SkillGate {
  return folder === skill.name
    ? { value: skill }
    : { reason: `The pack folder ${folder} must match its SKILL.md name ${skill.name}.` };
}

export const loadNeoPackSkill = (superpipe({})('neo-file-pack-load') as PipelineAPI)
  .input(['id', 'root', 'read'])
  .pipe(
    (id: string, root: string, read: (file: string) => string) => read(join(root, id, 'SKILL.md')),
    ['id', 'root', 'read'],
    'markdown'
  )
  .pipe(parseNeoPackSkill, 'markdown', 'result:skill')
  .pipe(requireNeoPackSkillStatic, 'skill', 'result:skill')
  .pipe(requireNeoPackFolderName, ['id', 'skill'], 'result:skill')
  .pipe(
    (skill: NeoPackSkill): NeoPack => ({
      id: skill.name,
      describe: skill.description,
      instructions: () => skill.body,
    }),
    'skill',
    'skill'
  )
  .end('skill') as (id: string, root: string, read: (file: string) => string) => NeoPack | string;

export function neoPackIds(entries: readonly string[]): string[] {
  return entries.filter((entry) => PACK_ID.test(entry)).sort();
}

export function loadNeoFilePacks(deps: {
  root: string;
  read?: (file: string) => string;
  list?: (dir: string) => string[];
  warn?: (id: string, error: unknown) => void;
}): readonly NeoPack[] {
  const read = deps.read ?? ((file: string) => readFileSync(file, 'utf8'));
  const list = deps.list ?? ((dir: string) => readdirSync(dir));
  const warn = deps.warn ?? (() => {});
  let folders: string[];
  try {
    folders = neoPackIds(list(deps.root));
  } catch {
    return [];
  }
  const packs: NeoPack[] = [];
  for (const id of folders) {
    try {
      const loaded = loadNeoPackSkill(id, deps.root, read);
      if (typeof loaded === 'string') warn(id, new Error(loaded));
      else packs.push(loaded);
    } catch (error) {
      warn(id, error);
    }
  }
  return packs;
}
