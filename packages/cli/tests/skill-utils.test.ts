import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { syncBuiltinSkillsFromDir, ensureBuiltinSkills } from '../src/skill-utils';

describe('syncBuiltinSkillsFromDir', () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), 'hyperneo-skill-src-'));
    destDir = await mkdtemp(join(tmpdir(), 'hyperneo-skill-dest-'));
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  });

  test('copies files from source to destination preserving directory structure', async () => {
    await mkdir(join(srcDir, 'playwright'), { recursive: true });
    await mkdir(join(srcDir, 'playwright', 'scripts'), { recursive: true });
    await writeFile(join(srcDir, 'playwright', 'SKILL.md'), '# Playwright Skill');
    await writeFile(join(srcDir, 'playwright', 'scripts', 'playwright_cli.sh'), '#!/bin/bash');

    const count = await syncBuiltinSkillsFromDir(srcDir, destDir);

    expect(count).toBe(2);
    const skillMd = await readFile(join(destDir, 'playwright', 'SKILL.md'), 'utf-8');
    expect(skillMd).toBe('# Playwright Skill');
    const script = await readFile(
      join(destDir, 'playwright', 'scripts', 'playwright_cli.sh'),
      'utf-8'
    );
    expect(script).toBe('#!/bin/bash');
  });

  test('returns count of files written', async () => {
    await mkdir(join(srcDir, 'skill-a'), { recursive: true });
    await writeFile(join(srcDir, 'skill-a', 'SKILL.md'), '# A');
    await writeFile(join(srcDir, 'skill-a', 'README.md'), '# Readme');

    const count = await syncBuiltinSkillsFromDir(srcDir, destDir);
    expect(count).toBe(2);
  });

  test('does NOT overwrite existing files (preserves user edits)', async () => {
    await mkdir(join(srcDir, 'playwright'), { recursive: true });
    await writeFile(join(srcDir, 'playwright', 'SKILL.md'), '# New Content');

    await mkdir(join(destDir, 'playwright'), { recursive: true });
    await writeFile(join(destDir, 'playwright', 'SKILL.md'), '# User Edits');

    const count = await syncBuiltinSkillsFromDir(srcDir, destDir);

    expect(count).toBe(0);
    const content = await readFile(join(destDir, 'playwright', 'SKILL.md'), 'utf-8');
    expect(content).toBe('# User Edits');
  });

  test('returns 0 when source directory does not exist', async () => {
    const nonExistentSrc = join(tmpdir(), 'does-not-exist-' + Date.now());
    const count = await syncBuiltinSkillsFromDir(nonExistentSrc, destDir);
    expect(count).toBe(0);
  });

  test('copies multiple skill directories', async () => {
    await mkdir(join(srcDir, 'playwright'), { recursive: true });
    await mkdir(join(srcDir, 'playwright-interactive'), { recursive: true });
    await writeFile(join(srcDir, 'playwright', 'SKILL.md'), '# PW');
    await writeFile(join(srcDir, 'playwright-interactive', 'SKILL.md'), '# PWI');

    const count = await syncBuiltinSkillsFromDir(srcDir, destDir);
    expect(count).toBe(2);

    const pw = await readFile(join(destDir, 'playwright', 'SKILL.md'), 'utf-8');
    expect(pw).toBe('# PW');
    const pwi = await readFile(join(destDir, 'playwright-interactive', 'SKILL.md'), 'utf-8');
    expect(pwi).toBe('# PWI');
  });

  test('creates destination subdirectories as needed', async () => {
    await mkdir(join(srcDir, 'skill', 'deep', 'nested'), { recursive: true });
    await writeFile(join(srcDir, 'skill', 'deep', 'nested', 'file.txt'), 'data');

    const count = await syncBuiltinSkillsFromDir(srcDir, destDir);
    expect(count).toBe(1);

    const content = await readFile(join(destDir, 'skill', 'deep', 'nested', 'file.txt'), 'utf-8');
    expect(content).toBe('data');
  });
});

describe('ensureBuiltinSkills', () => {
  let srcDir: string;
  let destDir: string;

  beforeEach(async () => {
    srcDir = await mkdtemp(join(tmpdir(), 'hyperneo-ensure-src-'));
    destDir = await mkdtemp(join(tmpdir(), 'hyperneo-ensure-dest-'));
  });

  afterEach(async () => {
    await rm(srcDir, { recursive: true, force: true });
    await rm(destDir, { recursive: true, force: true });
  });

  test('completes without throwing even when source does not exist', async () => {
    const nonExistent = join(tmpdir(), 'no-such-dir-' + Date.now());
    await expect(ensureBuiltinSkills(nonExistent, destDir)).resolves.toBeUndefined();
  });

  test('copies files and does not throw on success', async () => {
    await mkdir(join(srcDir, 'playwright'), { recursive: true });
    await writeFile(join(srcDir, 'playwright', 'SKILL.md'), '# PW');

    await expect(ensureBuiltinSkills(srcDir, destDir)).resolves.toBeUndefined();

    const content = await readFile(join(destDir, 'playwright', 'SKILL.md'), 'utf-8');
    expect(content).toBe('# PW');
  });
});
