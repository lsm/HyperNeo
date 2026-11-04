import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function verifyNativeProofParity(manifest: string, source: string): number {
  const [header, ...pinned] = manifest.trimEnd().split(/\r?\n/);
  const expected = /^sha256\t([a-f0-9]{64})$/.exec(header)?.[1];
  if (!expected || pinned.length === 0) throw new Error('Invalid or empty parity manifest');
  const digest = createHash('sha256').update(source).digest('hex');
  if (digest !== expected)
    throw new Error('Runner changed: review setup and refresh the parity manifest in the same PR');
  const commands = source
    .replace(/\\\r?\n[ \t]*/g, ' ')
    .split(/\r?\n/)
    .filter(
      (line) =>
        /^\s*env -i\b/.test(line) &&
        /\bdeno run\b/.test(line) &&
        line.includes('$REPO_ROOT/.claude/skills/verify/')
    )
    .map((line) => {
      const helper = /\$REPO_ROOT\/\.claude\/skills\/verify\/([^"]+)/.exec(line)?.[1];
      return helper + '\t' + line.trim();
    });
  if (commands.length !== pinned.length)
    throw new Error(
      'Helper count changed: pinned ' + pinned.length + ', runner ' + commands.length
    );
  for (let i = 0; i < commands.length; i++)
    if (commands[i] !== pinned[i])
      throw new Error('Helper command or order differs at manifest entry ' + (i + 1));
  return commands.length;
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 0 && args.length !== 2)
      throw new Error('Expected no arguments, or manifest and source paths');
    const count = verifyNativeProofParity(
      readFileSync(args[0] ?? new URL('./native-proof-parity.manifest', import.meta.url), 'utf8'),
      readFileSync(args[1] ?? new URL('./deno-smoke.sh', import.meta.url), 'utf8')
    );
    console.log('Native proof parity: ' + count + ' ordered helper commands pinned');
  } catch (error) {
    console.error('Native proof parity: ' + String(error));
    process.exitCode = 1;
  }
}
