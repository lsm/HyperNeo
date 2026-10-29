import { posix } from 'node:path';

export function codingHumanSignoff(
  patterns: readonly string[],
  files: readonly string[] | null,
  labels: readonly string[] | null
): boolean | null {
  const paths = patterns.filter((pattern) => !pattern.startsWith('label:'));
  const names = patterns.filter(
    (pattern) => pattern.startsWith('label:') || !pattern.includes('/')
  );
  if ((paths.length && files === null) || (names.length && labels === null)) return null;
  return (
    paths.some((pattern) => files?.some((file) => posix.matchesGlob(file, pattern))) ||
    names.some((pattern) =>
      labels?.some((label) => posix.matchesGlob(label, pattern.replace(/^label:/, '')))
    )
  );
}
