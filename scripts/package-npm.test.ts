import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = join(import.meta.dir, 'package-npm.ts');

function writeDummyBinaries(binDir: string, targets: string[]) {
  mkdirSync(binDir, { recursive: true });
  for (const target of targets) {
    const ext = target.includes('windows') ? '.exe' : '';
    writeFileSync(join(binDir, `hyperneo-${target}${ext}`), `dummy-${target}`);
  }
}

function runPackager(binDir: string, npmDir: string) {
  return spawnSync('bun', [scriptPath, '--version', '0.0.0-test'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HYPERNEO_PACKAGE_BIN_DIR: binDir,
      HYPERNEO_PACKAGE_NPM_DIR: npmDir,
    },
  });
}

describe('package-npm', () => {
  it('packages every platform binary including the Windows exe', () => {
    const dir = mkdtempSync(join(tmpdir(), 'package-npm-'));
    try {
      const binDir = join(dir, 'bin');
      writeDummyBinaries(binDir, [
        'darwin-arm64',
        'darwin-x64',
        'linux-x64',
        'linux-arm64',
        'windows-x64',
      ]);
      const npmDir = join(dir, 'npm');

      const result = runPackager(binDir, npmDir);
      expect(result.status).toBe(0);

      const win = JSON.parse(readFileSync(join(npmDir, 'cli-windows-x64', 'package.json'), 'utf8'));
      expect(win.name).toBe('@hyperneo/cli-windows-x64');
      expect(win.os).toEqual(['win32']);
      expect(win.cpu).toEqual(['x64']);
      expect(win.bin).toEqual({ hyperneo: 'bin/hyperneo.exe' });
      expect(readFileSync(join(npmDir, 'cli-windows-x64', 'bin', 'hyperneo.exe'), 'utf8')).toBe(
        'dummy-windows-x64'
      );

      const mac = JSON.parse(
        readFileSync(join(npmDir, 'cli-darwin-arm64', 'package.json'), 'utf8')
      );
      expect(mac.os).toEqual(['darwin']);
      expect(mac.bin).toEqual({ hyperneo: 'bin/hyperneo' });
      expect(readFileSync(join(npmDir, 'cli-darwin-arm64', 'bin', 'hyperneo'), 'utf8')).toBe(
        'dummy-darwin-arm64'
      );

      const main = JSON.parse(readFileSync(join(npmDir, 'hyperneo', 'package.json'), 'utf8'));
      expect(main.version).toBe('0.0.0-test');
      expect(main.optionalDependencies).toEqual({
        '@hyperneo/cli-darwin-arm64': '0.0.0-test',
        '@hyperneo/cli-darwin-x64': '0.0.0-test',
        '@hyperneo/cli-linux-x64': '0.0.0-test',
        '@hyperneo/cli-linux-arm64': '0.0.0-test',
        '@hyperneo/cli-windows-x64': '0.0.0-test',
      });

      const launcher = readFileSync(join(npmDir, 'hyperneo', 'bin', 'hyperneo.js'), 'utf8');
      expect(launcher).toContain("'win32-x64': '@hyperneo/cli-windows-x64'");
      expect(launcher).toContain("process.platform === 'win32' ? 'hyperneo.exe' : 'hyperneo'");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips platforms whose binary is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'package-npm-'));
    try {
      const binDir = join(dir, 'bin');
      writeDummyBinaries(binDir, ['darwin-arm64']);
      const npmDir = join(dir, 'npm');

      const result = runPackager(binDir, npmDir);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain('Binary not found');
      expect(existsSync(join(npmDir, 'cli-darwin-arm64'))).toBe(true);
      expect(existsSync(join(npmDir, 'cli-windows-x64'))).toBe(false);
      expect(existsSync(join(npmDir, 'hyperneo'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
