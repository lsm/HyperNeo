import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function extractPhoneMethods(swift: string): string[] {
  return [
    ...new Set(
      [
        ...swift.matchAll(
          /\b(?:invoke|request|call|onEvent|\w+Request)\s*\(\s*"([A-Za-z][\w]*(?:\.[\w]+)+)"/g
        ),
      ].map((match) => match[1]!)
    ),
  ].sort();
}
export function phoneMethodsFromSource(
  repository: string,
  ref: string
): { sourceCommit: string; methods: string[]; events: string[] } {
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', repository, ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (result.exitCode) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const sourceCommit = git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`);
  const files = git('ls-tree', '-r', '--name-only', sourceCommit)
    .split('\n')
    .filter(
      (file) => file.endsWith('.swift') && !file.split('/').some((part) => part.endsWith('Tests'))
    );
  const swift = files.map((file) => git('show', `${sourceCommit}:${file}`)).join('\n');
  const methods = extractPhoneMethods(swift);
  if (!methods.length)
    throw new Error('No literal phone API methods found at the specified source commit');
  return { sourceCommit, methods, events: extractPhoneEventMethods(swift) };
}
export function extractPhoneEventMethods(swift: string): string[] {
  return [
    ...new Set(
      [...swift.matchAll(/\bonEvent\s*\(\s*"([A-Za-z][\w]*(?:\.[\w]+)+)"/g)].map(
        (match) => match[1]!
      )
    ),
  ].sort();
}
if (import.meta.main) {
  const [repository, ref, ...extra] = process.argv.slice(2);
  if (!repository || extra.length)
    throw new Error('Usage: bun run api:phone-methods <source-repository> [source-ref]');
  const defaults = JSON.parse(
    readFileSync(resolve(import.meta.dir, '../api-phone-methods.json'), 'utf8')
  ) as { sourceCommit: string; sourceEvidence?: string };
  const result = phoneMethodsFromSource(repository, ref ?? defaults.sourceCommit);
  console.log(
    JSON.stringify(
      {
        ...result,
        ...(result.sourceCommit === defaults.sourceCommit && defaults.sourceEvidence
          ? { sourceEvidence: defaults.sourceEvidence }
          : {}),
      },
      null,
      2
    )
  );
}
