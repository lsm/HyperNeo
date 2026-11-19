import { readFileSync } from 'node:fs';

const verdicts = ['named', 'missing', 'misnamed', 'dynamic', 'unreadable'] as const;
type Verdict = (typeof verdicts)[number];
type Route = { file: string; name: string; variant?: string; verdict: Verdict };
type Change = {
  file: string;
  name: string;
  variant?: string;
  before: Verdict | null;
  after: Verdict | null;
};

function routes(input: unknown): Map<string, Route> {
  if (!Array.isArray(input)) throw new Error('Expected an array of pipeline verdicts');
  const result = new Map<string, Route>();
  const families = new Map<string, boolean>();
  for (const item of input) {
    if (
      !item ||
      typeof item !== 'object' ||
      typeof item.file !== 'string' ||
      !item.file ||
      typeof item.name !== 'string' ||
      !item.name ||
      (item.variant !== undefined && (typeof item.variant !== 'string' || !item.variant)) ||
      !verdicts.includes(item.verdict)
    )
      throw new Error('Invalid pipeline verdict');
    const route: Route = {
      file: item.file,
      name: item.name,
      ...(item.variant === undefined ? {} : { variant: item.variant }),
      verdict: item.verdict,
    };
    const key = JSON.stringify([route.file, route.name, route.variant ?? null]);
    if (result.has(key)) throw new Error(`Duplicate pipeline verdict: ${route.name}`);
    const family = JSON.stringify([route.file, route.name]);
    if (families.has(family) && (families.get(family) || route.variant === undefined))
      throw new Error(`Ambiguous pipeline verdict variants: ${route.name}`);
    families.set(family, route.variant === undefined);
    result.set(key, route);
  }
  return result;
}

export function comparePipelineVerdicts(baseInput: unknown, headInput: unknown) {
  const base = routes(baseInput);
  const head = routes(headInput);
  const changes: Change[] = [];
  for (const key of new Set([...base.keys(), ...head.keys()])) {
    const oldRoute = base.get(key);
    const newRoute = head.get(key);
    if (oldRoute?.verdict === newRoute?.verdict) continue;
    const route = newRoute ?? oldRoute;
    if (!route) continue;
    changes.push({
      file: route.file,
      name: route.name,
      ...(route.variant === undefined ? {} : { variant: route.variant }),
      before: oldRoute?.verdict ?? null,
      after: newRoute?.verdict ?? null,
    });
  }
  changes.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.name.localeCompare(b.name) ||
      (a.variant ?? '').localeCompare(b.variant ?? '')
  );
  return { changes, regressions: changes.filter((change) => change.after !== 'named') };
}

if (import.meta.main) {
  try {
    const [base, head] = process.argv.slice(2);
    if (!base || !head || process.argv.length !== 4)
      throw new Error('Expected base and head JSON files');
    const result = comparePipelineVerdicts(
      JSON.parse(readFileSync(base, 'utf8')),
      JSON.parse(readFileSync(head, 'utf8'))
    );
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.regressions.length ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
