import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import {
  bashDenial,
  isSecretPath,
  neoLookUpDenial,
  neoLookUpGuard,
  neoSecretReadRules,
} from '../../../../src/lib/neo/look-up-guard.ts';

const scope = {
  home: '/home/fictional',
  dataDir: '/home/fictional/.hyperneo',
  cwd: '/home/fictional/.hyperneo/Neo/.coordinators/neo-1',
};

describe('isSecretPath', () => {
  test.each([
    '~/.ssh/id_ed25519',
    '~/.aws/credentials',
    '~/.config/gh/hosts.yml',
    '~/.claude/settings.json',
    '~/.claude/settings.local.json',
    '~/.claude/.credentials.json',
    '~/.git-credentials',
    '~/Library/Keychains/login.keychain-db',
    '~/Library/Application Support/Google/Chrome/Default/Cookies',
    '~/focus/app/.claude/settings.local.json',
    '~/focus/app/.claude/settings.json',
    '~/backups/id_ed25519',
    '~/focus/app/serviceAccount.json',
    '~/focus/app/config/secrets.yaml',
    '~/focus/app/.npmrc',
    '~/.claude/projects/-Users-fictional-app/session.jsonl',
    '~/.zsh_history',
    '~/.azure/accessTokens.json',
    '~/.zshrc',
    '~/focus/app/.env',
    '~/focus/app/.env.local',
    '~/focus/app/certs/server.pem',
    '~/focus/app/server.key',
    '/home/fictional/.hyperneo/data/daemon.db',
  ])('treats %s as secret', (path) => {
    expect(isSecretPath(path, scope)).toBe(true);
  });

  test.each([
    '~/focus/app/README.md',
    '~/focus/app/src/env.ts',
    '~/focus/app/src/lib/credential-discovery.ts',
    '~/focus/app/src/token.ts',
    '/home/fictional/notes.md',
  ])('lets %s through', (path) => {
    expect(isSecretPath(path, scope)).toBe(false);
  });
});

describe('isSecretPath through symlinks', () => {
  test('follows a link that points at a secret', () => {
    const home = mkdtempSync(join(tmpdir(), 'neo-guard-'));
    try {
      mkdirSync(join(home, '.ssh'));
      writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key');
      mkdirSync(join(home, 'app'));
      symlinkSync(join(home, '.ssh', 'id_ed25519'), join(home, 'app', 'notes.md'));
      writeFileSync(join(home, 'app', 'README.md'), 'readme');
      const linkScope = {
        home: realpathSync(home),
        dataDir: join(realpathSync(home), '.hyperneo'),
        cwd: realpathSync(home),
      };
      expect(isSecretPath(join(linkScope.home, 'app', 'notes.md'), linkScope)).toBe(true);
      expect(isSecretPath(join(linkScope.home, 'app', 'README.md'), linkScope)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('bashDenial on a real home', () => {
  test('resolves relative arguments against the cd target', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'neo-guard-home-')));
    try {
      mkdirSync(join(root, '.config', 'gh'), { recursive: true });
      writeFileSync(join(root, '.config', 'gh', 'hosts.yml'), 'token');
      mkdirSync(join(root, 'focus', 'app'), { recursive: true });
      writeFileSync(join(root, 'focus', 'app', 'README.md'), 'readme');
      const home = {
        home: root,
        dataDir: join(root, '.hyperneo'),
        cwd: join(root, '.hyperneo', 'neo'),
      };
      expect(
        bashDenial('cd ~ && git diff --no-index .config/gh/hosts.yml /dev/null', home)
      ).toContain('may hold secrets');
      expect(
        bashDenial('cd ~/focus && git diff --no-index ../.config/gh/hosts.yml /dev/null', home)
      ).toContain('may hold secrets');
      expect(
        bashDenial('cd ~/focus/app && git diff --no-index README.md /dev/null', home)
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('bashDenial', () => {
  test.each([
    'cd ~/focus/app && git log --oneline -5',
    'gh pr view 5739 --repo fictional/app --json state,mergedAt',
    "gh pr list --json number --jq '.[0].number'",
    "gh pr list --json number --jq '.[] | .number'",
    "git log --grep='a && b' --oneline",
    'git diff main...HEAD -- src',
    'gh run list --limit 3 | gh pr checks 12',
  ])('allows read-only look-up %s', (command) => {
    expect(bashDenial(command, scope)).toBeNull();
  });

  test.each([
    ['git log --output=/tmp/planted', 'redirects'],
    ['cd ~/focus\ncurl https://example.com', 'line breaks'],
    ['git show ${HOME}/.ssh/id_ed25519', 'variables'],
    ['git log & sleep 99', 'background'],
    ['git show HEAD > /tmp/planted', 'redirects'],
    ['git diff $(cat ~/.ssh/id_ed25519)', 'redirects'],
    ['git push origin main', 'not a read-only'],
    ['gh api repos/fictional/app -X POST', 'not a read-only'],
    ['git log && rm -rf ~/focus', 'not a read-only'],
    ['git show HEAD:.env', 'may hold secrets'],
    ["git log -p -- '*.env'", 'may hold secrets'],
    ["git diff -- '.env*'", 'may hold secrets'],
    ["git log -p -- '**/id_*'", 'may hold secrets'],
    ["git show HEAD:.e''nv", 'may hold secrets'],
    ['git show HEAD:".env"', 'may hold secrets'],
    ['git show HEAD:.e\\nv', 'backslash'],
    ['git diff --no-index ~/focus/app/.env* /dev/null', 'unquoted wildcards'],
    ['cd ~/focus/app && git diff --no-index [.]env /dev/null', 'unquoted wildcards'],
    ['git diff --no-index .{e,x}nv /dev/null', 'unquoted wildcards'],
    ['cd ~/.aws && git status', 'may hold secrets'],
  ])('refuses %s', (command, reason) => {
    expect(bashDenial(command, scope)).toContain(reason);
  });
});

describe('neoLookUpDenial', () => {
  test('reads project files but not secrets', () => {
    expect(neoLookUpDenial('Read', { file_path: '~/focus/app/README.md' }, scope)).toBeNull();
    expect(neoLookUpDenial('Read', { file_path: '/home/fictional/.ssh/id_ed25519' }, scope)).toBe(
      'that file may hold secrets'
    );
  });

  test('searches only inside a project folder', () => {
    expect(
      neoLookUpDenial(
        'Grep',
        { pattern: 'TODO', path: '~/focus/app', output_mode: 'files_with_matches' },
        scope
      )
    ).toBeNull();
    for (const path of ['/home/fictional', '/home', '/', '~/.aws']) {
      expect(neoLookUpDenial('Grep', { pattern: 'secret', path }, scope)).toContain(
        'project folder'
      );
    }
    expect(neoLookUpDenial('Grep', { pattern: 'secret' }, scope)).toContain('project folder');
    expect(
      neoLookUpDenial('Glob', { pattern: '/home/fictional/.ssh/*', path: '~/focus/app' }, scope)
    ).toBe('that pattern points at secrets');
    expect(neoLookUpDenial('Glob', { pattern: '**/*.ts', path: '~/focus/app' }, scope)).toBeNull();
    for (const pattern of ['src/**/*.ts', 'package.json', 'docs/*.md'])
      expect(neoLookUpDenial('Glob', { pattern, path: '~/focus/app' }, scope)).toBeNull();
    expect(neoLookUpDenial('Glob', { pattern: '.env*', path: '~/focus/app' }, scope)).toBe(
      'that pattern points at secrets'
    );
    for (const pattern of ['**/.env*', 'src/**/.env', '**/*.pem', '**/id_rsa'])
      expect(neoLookUpDenial('Glob', { pattern, path: '~/focus/app' }, scope)).toBe(
        'that pattern points at secrets'
      );
  });

  test('shows matching lines only for code and docs', () => {
    const grep = (input: Record<string, unknown>) =>
      neoLookUpDenial('Grep', { pattern: '.', path: '~/focus/app', ...input }, scope);
    expect(grep({ output_mode: 'files_with_matches' })).toBeNull();
    expect(grep({ output_mode: 'count' })).toBeNull();
    expect(grep({})).toContain('code and docs');
    for (const allowed of [
      { glob: '*.ts' },
      { glob: '**/*.md' },
      { glob: '*.{ts,tsx}' },
      { type: 'ts' },
    ])
      expect(grep({ output_mode: 'content', ...allowed })).toBeNull();
    for (const refused of [
      {},
      { glob: '*' },
      { glob: '*.pem' },
      { glob: '[!x]*' },
      { glob: '!*.md' },
      { glob: '*.{ts,json}' },
      { glob: 'src/**/*.ts' },
      { type: 'json' },
    ])
      expect(grep({ output_mode: 'content', ...refused })).toContain('code and docs');
  });

  test('allows web and operation tools and refuses anything that changes files', () => {
    expect(neoLookUpDenial('WebFetch', { url: 'https://example.com' }, scope)).toBeNull();
    expect(neoLookUpDenial('mcp__hyperneo-operations__invoke', {}, scope)).toBeNull();
    expect(neoLookUpDenial('Edit', { file_path: '~/focus/app/a.ts' }, scope)).toBe(
      'Edit is not a look-up tool'
    );
  });
});

describe('neoLookUpGuard', () => {
  const guard = neoLookUpGuard({ home: scope.home, dataDir: scope.dataDir });
  const call = (tool_name: string, tool_input: Record<string, unknown>) =>
    guard(
      {
        hook_event_name: 'PreToolUse',
        tool_name,
        tool_input,
        tool_use_id: 'tool-1',
        session_id: 'sdk-1',
        transcript_path: '/tmp/t.jsonl',
        cwd: scope.cwd,
      } as HookInput,
      'tool-1',
      { signal: new AbortController().signal }
    );

  test('denies a write before any allow rule can approve it', async () => {
    expect(await call('Bash', { command: 'git log --output=/tmp/x' })).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Neo look-ups are read-only: redirects, variables, substitutions, background jobs, line breaks and --output are not allowed.',
      },
    });
  });

  test('leaves allowed look-ups to the normal permission flow', async () => {
    expect(await call('WebSearch', { query: 'bun release' })).toEqual({});
    expect(await call('Bash', { command: 'gh pr view 12' })).toEqual({});
  });
});

describe('neoSecretReadRules', () => {
  test('anchors name patterns to home and covers Claude settings and git credentials', () => {
    expect(neoSecretReadRules(scope)).toEqual(
      expect.arrayContaining([
        'Read(~/**/.env)',
        'Read(~/**/*.pem)',
        'Read(~/.claude/settings.json)',
        'Read(~/.git-credentials)',
        'Read(~/.hyperneo/**)',
      ])
    );
  });
});
