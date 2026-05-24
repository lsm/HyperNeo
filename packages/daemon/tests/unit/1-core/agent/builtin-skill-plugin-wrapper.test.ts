/**
 * Tests for the builtin-skill → SDK-plugin wrapper generator.
 *
 * The unit under test materialises a small plugin directory at
 * `<wrappersRoot>/<commandName>/` that bridges the agent-skills layout used by
 * NeoKai (`SKILL.md` at the root of the skill dir) to the plugin layout the
 * Claude Agent SDK requires (`.claude-plugin/plugin.json` at the root, skills
 * under `skills/<name>/`). The real bug these tests guard against is the SDK
 * silently dropping plugin entries whose directories lack that manifest — the
 * root cause of `/playwright` returning "Unknown command".
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile, stat, lstat, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  builtinSkillPluginPath,
  defaultBuiltinSkillPluginRoot,
  ensureBuiltinSkillPluginWrapper,
  ensureBuiltinSkillPluginWrappers,
} from '../../../../src/lib/agent/builtin-skill-plugin-wrapper';

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('builtin-skill-plugin-wrapper', () => {
  let tmpRoot: string;
  let wrappersRoot: string;
  let skillsRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'kai-skill-wrapper-'));
    wrappersRoot = join(tmpRoot, 'skill-plugins');
    skillsRoot = join(tmpRoot, 'skills');
    await mkdir(wrappersRoot, { recursive: true });
    await mkdir(skillsRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  describe('defaultBuiltinSkillPluginRoot', () => {
    it('resolves under ~/.neokai/skill-plugins', () => {
      const root = defaultBuiltinSkillPluginRoot();
      // Must live beside ~/.neokai/skills (not inside it) so regenerating
      // wrappers never clobbers user-editable skill content.
      expect(root.endsWith(join('.neokai', 'skill-plugins'))).toBe(true);
    });
  });

  describe('builtinSkillPluginPath', () => {
    it('joins commandName under the wrappers root', () => {
      const p = builtinSkillPluginPath('/tmp/wrappers', 'playwright');
      expect(p).toBe(join('/tmp/wrappers', 'playwright'));
    });
  });

  describe('ensureBuiltinSkillPluginWrapper', () => {
    it('creates .claude-plugin/plugin.json with the expected manifest shape', async () => {
      // The manifest at this exact location is what the SDK scans for to
      // treat a directory as a plugin. Without it the SDK logs
      // "No manifest found" and silently skips the plugin entry.
      const skillDir = join(skillsRoot, 'playwright');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# playwright\n');

      const wrapperDir = await ensureBuiltinSkillPluginWrapper(
        wrappersRoot,
        skillsRoot,
        'playwright',
        { description: 'Browser automation', version: '1.2.3' }
      );

      expect(wrapperDir).toBe(join(wrappersRoot, 'playwright'));

      const manifestPath = join(wrapperDir, '.claude-plugin', 'plugin.json');
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      expect(manifest).toEqual({
        name: 'playwright',
        version: '1.2.3',
        description: 'Browser automation',
      });
    });

    it('omits description from manifest when not provided', async () => {
      const wrapperDir = await ensureBuiltinSkillPluginWrapper(
        wrappersRoot,
        skillsRoot,
        'some-skill'
      );

      const manifest = JSON.parse(
        await readFile(join(wrapperDir, '.claude-plugin', 'plugin.json'), 'utf8')
      );
      expect(manifest.name).toBe('some-skill');
      expect(manifest.version).toBe('0.0.0');
      expect('description' in manifest).toBe(false);
    });

    it('omits description when explicitly empty string', async () => {
      // Empty description would otherwise pollute plugin UI with a blank field.
      await ensureBuiltinSkillPluginWrapper(wrappersRoot, skillsRoot, 'x', { description: '' });
      const manifest = JSON.parse(
        await readFile(join(wrappersRoot, 'x', '.claude-plugin', 'plugin.json'), 'utf8')
      );
      expect('description' in manifest).toBe(false);
    });

    it('creates skills/<commandName>/ that resolves to the source skill directory', async () => {
      // This is the actual mechanism that lets the SDK find SKILL.md —
      // the wrapper's skills/<name>/SKILL.md must resolve to content, whether
      // via a symlink (preferred) or a copied mirror (fallback).
      const skillDir = join(skillsRoot, 'playwright');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# playwright body\n');

      const wrapperDir = await ensureBuiltinSkillPluginWrapper(
        wrappersRoot,
        skillsRoot,
        'playwright'
      );

      const resolvedSkillFile = join(wrapperDir, 'skills', 'playwright', 'SKILL.md');
      const body = await readFile(resolvedSkillFile, 'utf8');
      expect(body).toBe('# playwright body\n');
    });

    it('uses a symlink when the platform permits', async () => {
      // macOS/Linux always hit this branch — confirms we aren't silently
      // doing an expensive recursive copy on every startup.
      if (process.platform === 'win32') return; // skip where symlinks are unreliable
      const skillDir = join(skillsRoot, 'playwright');
      await mkdir(skillDir, { recursive: true });

      const wrapperDir = await ensureBuiltinSkillPluginWrapper(
        wrappersRoot,
        skillsRoot,
        'playwright'
      );

      const linkPath = join(wrapperDir, 'skills', 'playwright');
      const lst = await lstat(linkPath);
      expect(lst.isSymbolicLink()).toBe(true);
      const target = await readlink(linkPath);
      expect(target).toBe(skillDir);
    });

    it('is idempotent — repeated calls keep the same symlink', async () => {
      // Daemon startup calls this on every boot; installSkillFromGit calls it
      // whenever a skill is added. It MUST NOT explode or rebuild unnecessarily.
      if (process.platform === 'win32') return;
      const skillDir = join(skillsRoot, 'playwright');
      await mkdir(skillDir, { recursive: true });

      await ensureBuiltinSkillPluginWrapper(wrappersRoot, skillsRoot, 'playwright');
      const firstLst = await lstat(join(wrappersRoot, 'playwright', 'skills', 'playwright'));

      await ensureBuiltinSkillPluginWrapper(wrappersRoot, skillsRoot, 'playwright');
      await ensureBuiltinSkillPluginWrapper(wrappersRoot, skillsRoot, 'playwright');
      const lastLst = await lstat(join(wrappersRoot, 'playwright', 'skills', 'playwright'));

      expect(lastLst.isSymbolicLink()).toBe(true);
      // ino stability is a decent proxy for "we didn't delete+recreate pointlessly"
      expect(lastLst.ino).toBe(firstLst.ino);
    });

    it('replaces a stale symlink whose target has drifted', async () => {
      // If the skills root moves (e.g. migration), the wrapper must re-point.
      if (process.platform === 'win32') return;
      const oldSkillsRoot = join(tmpRoot, 'old-skills');
      const newSkillsRoot = join(tmpRoot, 'new-skills');
      await mkdir(join(oldSkillsRoot, 'playwright'), { recursive: true });
      await mkdir(join(newSkillsRoot, 'playwright'), { recursive: true });

      await ensureBuiltinSkillPluginWrapper(wrappersRoot, oldSkillsRoot, 'playwright');
      await ensureBuiltinSkillPluginWrapper(wrappersRoot, newSkillsRoot, 'playwright');

      const target = await readlink(join(wrappersRoot, 'playwright', 'skills', 'playwright'));
      expect(target).toBe(join(newSkillsRoot, 'playwright'));
    });

    it('replaces a pre-existing regular directory at the skill link path', async () => {
      // Guards a worst-case recovery: a stale mirror-copy directory left over
      // from a previous Windows-style fallback run should be cleaned up so
      // the preferred symlink can take over.
      if (process.platform === 'win32') return;
      const skillDir = join(skillsRoot, 'playwright');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), '# real\n');

      // Seed the wrapper with a stale real directory in place of the link.
      const stalePath = join(wrappersRoot, 'playwright', 'skills', 'playwright');
      await mkdir(stalePath, { recursive: true });
      await writeFile(join(stalePath, 'stale.txt'), 'leftover');

      await ensureBuiltinSkillPluginWrapper(wrappersRoot, skillsRoot, 'playwright');

      const lst = await lstat(stalePath);
      expect(lst.isSymbolicLink()).toBe(true);
      // Stale contents are gone because the real dir was removed first.
      expect(await pathExists(join(stalePath, 'stale.txt'))).toBe(false);
      // Real content now reachable through the fresh link.
      expect(await readFile(join(stalePath, 'SKILL.md'), 'utf8')).toBe('# real\n');
    });

    it('creates the wrapper even if the source skill directory does not yet exist', async () => {
      // Startup order isn't strictly guaranteed — a later sync step may
      // populate the skill dir. The wrapper should still materialise so the
      // link resolves once the target appears.
      if (process.platform === 'win32') return;
      const wrapperDir = await ensureBuiltinSkillPluginWrapper(
        wrappersRoot,
        skillsRoot,
        'not-yet-synced'
      );
      expect(await pathExists(join(wrapperDir, '.claude-plugin', 'plugin.json'))).toBe(true);
      const linkPath = join(wrapperDir, 'skills', 'not-yet-synced');
      const lst = await lstat(linkPath);
      expect(lst.isSymbolicLink()).toBe(true);
    });
  });

  describe('ensureBuiltinSkillPluginWrappers (batch)', () => {
    it('returns a map of commandName → wrapper directory', async () => {
      await mkdir(join(skillsRoot, 'playwright'), { recursive: true });
      await mkdir(join(skillsRoot, 'playwright-interactive'), { recursive: true });

      const result = await ensureBuiltinSkillPluginWrappers(wrappersRoot, skillsRoot, [
        { commandName: 'playwright', description: 'Browser automation' },
        { commandName: 'playwright-interactive' },
      ]);

      expect(result.size).toBe(2);
      expect(result.get('playwright')).toBe(join(wrappersRoot, 'playwright'));
      expect(result.get('playwright-interactive')).toBe(
        join(wrappersRoot, 'playwright-interactive')
      );
    });

    it('continues when a single skill fails', async () => {
      // One broken skill must never prevent the daemon from coming up.
      // We force a failure by making the wrappers root a plain file so
      // mkdir on the first skill will fail, then assert the second skill
      // still succeeds when given a usable root.
      await mkdir(join(skillsRoot, 'ok-skill'), { recursive: true });

      const brokenRoot = join(tmpRoot, 'broken-root');
      await writeFile(brokenRoot, 'not a directory');

      // First call targets broken root → should log and skip.
      const partial = await ensureBuiltinSkillPluginWrappers(brokenRoot, skillsRoot, [
        { commandName: 'ok-skill' },
      ]);
      expect(partial.size).toBe(0);

      // A subsequent call with the good root still works.
      const full = await ensureBuiltinSkillPluginWrappers(wrappersRoot, skillsRoot, [
        { commandName: 'ok-skill' },
      ]);
      expect(full.get('ok-skill')).toBe(join(wrappersRoot, 'ok-skill'));
    });
  });
});
