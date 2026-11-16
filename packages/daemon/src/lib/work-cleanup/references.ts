import { homedir } from 'node:os';

const leaves = (value: unknown): string[] =>
  typeof value === 'string'
    ? [value]
    : value && typeof value === 'object'
      ? Object.values(value).flatMap(leaves)
      : [];

const decoded = (stored: string): unknown => {
  try {
    return JSON.parse(stored);
  } catch {
    return stored;
  }
};

const decodedRun = (run: string) => {
  try {
    return decodeURIComponent(run);
  } catch {
    return run.replace(/%[0-7][0-9a-f]/gi, decodeURIComponent);
  }
};

export function mentionsFolder(stored: string, folder: string): boolean {
  return [stored, ...leaves(decoded(stored))].some((text) => {
    const expanded = text.replaceAll('~/', `${process.env.HOME || homedir()}/`);
    if (expanded.includes(folder)) return true;
    return expanded.replace(/(?:%[0-9a-f]{2})+/gi, decodedRun).includes(folder);
  });
}
