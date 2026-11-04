import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = new URL('../../../../../../', import.meta.url);
const checker = new URL('scripts/check-native-proof-parity.ts', root);
const manifest = new URL('scripts/native-proof-parity.manifest', root);
const source = new URL('scripts/deno-smoke.sh', root);
async function verify() {
  if (!existsSync(checker)) throw new Error('Native proof parity checker unavailable');
  return (await import(checker.href)).verifyNativeProofParity as (
    manifest: string,
    source: string
  ) => number;
}
describe('Native proof parity', () => {
  test('all 117 ordered helper commands remain pinned before runtime migration', async () => {
    const check = await verify();
    expect(check(readFileSync(manifest, 'utf8'), readFileSync(source, 'utf8'))).toBe(117);
  });
  test('missing, duplicate, added and reordered coverage entries fail', async () => {
    const check = await verify(),
      text = readFileSync(manifest, 'utf8'),
      script = readFileSync(source, 'utf8');
    const lines = text.trimEnd().split('\n'),
      [header, ...entries] = lines;
    for (const changed of [
      entries.slice(1),
      [entries[0], ...entries],
      [...entries, 'unregistered.ts\tdeno run unregistered.ts'],
      [entries[1], entries[0], ...entries.slice(2)],
    ])
      expect(() => check([header, ...changed].join('\n') + '\n', script)).toThrow();
  });
  test('helper identity, environment, runtime flags and mode arguments are protected', async () => {
    const check = await verify(),
      text = readFileSync(manifest, 'utf8'),
      script = readFileSync(source, 'utf8');
    for (const [from, to] of [
      ['neo-settings-writer.ts\t', 'other-proof.ts\t'],
      ['NODE_ENV=test', 'NODE_ENV=production'],
      ['--no-check', '--allow-read'],
      ['verify "$NEO_SETTINGS_RUN"', '"$NEO_SETTINGS_RUN"'],
    ]) {
      const changed = text.replace(from, to);
      expect(changed).not.toBe(text);
      expect(() => check(changed, script)).toThrow();
    }
  });
  test('source setup and binding drift fail even when the invocation text stays unchanged', async () => {
    const check = await verify(),
      text = readFileSync(manifest, 'utf8'),
      script = readFileSync(source, 'utf8');
    expect(() =>
      check(text, script.replace('PORT="$' + '{DENO_SMOKE_PORT:-9283}"', 'PORT="8399"'))
    ).toThrow();
    expect(() =>
      check(
        text,
        script.replace(
          'NEO_SETTINGS_RUN="$WORK_DIR/neo-settings-writer"',
          'NEO_SETTINGS_RUN="$WORK_DIR/other-home"'
        )
      )
    ).toThrow();
  });
  test('malformed and empty manifests reject instead of reporting parity', async () => {
    const check = await verify(),
      script = readFileSync(source, 'utf8');
    for (const invalid of ['', 'sha256\tinvalid\n', 'sha256\t' + '0'.repeat(64) + '\n'])
      expect(() => check(invalid, script)).toThrow();
  });
  test('the real CLI rejects drift without executing shell content', async () => {
    await verify();
    const run = mkdtempSync(join(tmpdir(), 'proof-parity-')),
      marker = join(run, 'executed');
    try {
      const text = readFileSync(manifest, 'utf8'),
        script = readFileSync(source, 'utf8');
      const manifestPath = join(run, 'proofs.manifest'),
        sourcePath = join(run, 'smoke.sh');
      writeFileSync(manifestPath, text);
      writeFileSync(sourcePath, script + '\ntouch "' + marker + '"\n');
      const result = spawnSync('bun', [checker.pathname, manifestPath, sourcePath], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: run, TMPDIR: run, NODE_ENV: 'test' },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Native proof parity');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(run, { recursive: true, force: true });
    }
  });
});
