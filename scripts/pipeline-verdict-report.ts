import { createHash } from 'node:crypto';
import ts from 'typescript';
import { countPipelineRoutes, isSource, readRepositorySources } from './system-map.ts';

const categories = ['missing', 'misnamed', 'dynamic', 'unreadable'] as const;
type Counts = ReturnType<typeof countPipelineRoutes>;
type Verdict = (typeof categories)[number] | 'named';
type Route = { file: string; name: string; variant?: string; verdict: Verdict };
type Definition = { start: number; end: number; name: string; schema?: string };

function definitions(file: string, source: string): Definition[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: Definition[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'defineOperation'
    ) {
      const arg = node.arguments[0];
      if (
        node.typeArguments?.length ||
        node.arguments.length !== 1 ||
        !ts.isObjectLiteralExpression(arg)
      )
        throw new Error(`Unsupported operation definition in ${file}`);
      const property = (name: string) =>
        arg.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(parsed) === name);
      const name = property('name');
      const schema = property('inputSchema');
      if (
        !name ||
        !ts.isPropertyAssignment(name) ||
        !ts.isStringLiteral(name.initializer) ||
        !name.initializer.text
      )
        throw new Error(`Operation name is not a literal in ${file}`);
      found.push({
        start: node.getStart(parsed),
        end: node.end,
        name: name.initializer.text,
        schema:
          schema && ts.isPropertyAssignment(schema)
            ? schema.initializer.getText(parsed)
            : undefined,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  found.sort((a, b) => a.start - b.start);
  if (found.some((call, index) => index > 0 && call.start < found[index - 1].end))
    throw new Error(`Nested operation definitions in ${file}`);
  return found;
}

function schemaVariant(schema: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.Standard,
    schema
  );
  const tokens: string[] = [];
  while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
  return `schema:${createHash('sha256').update(JSON.stringify(tokens)).digest('hex')}`;
}

export function reportPipelineVerdicts(
  sources: Map<string, string>,
  classify: (sources: Map<string, string>) => Counts = countPipelineRoutes
): Route[] {
  const routes: Route[] = [];
  for (const [file, source] of sources) {
    if (!isSource(file)) continue;
    const calls = definitions(file, source);
    if (!calls.length) continue;
    const mask = (keep?: Definition, except = false) => {
      let text = source;
      for (const call of [...calls].reverse())
        if (except ? call === keep : call !== keep)
          text = `${text.slice(0, call.start)}undefined${text.slice(call.end)}`;
      return new Map([[file, text]]);
    };
    const baseline = classify(mask());
    const totals = { ...baseline };
    const full = classify(new Map([[file, source]]));
    const variants = new Set<string>();
    for (const call of calls) {
      const delta = classify(mask(call));
      const without = classify(mask(call, true));
      const changes: Verdict[] = [];
      for (const key of categories) {
        const difference = delta[key] - baseline[key];
        if (
          !Number.isInteger(difference) ||
          difference < 0 ||
          difference > 1 ||
          full[key] - without[key] !== difference
        )
          throw new Error(`Ambiguous pipeline attribution for ${call.name} in ${file}`);
        totals[key] += difference;
        if (difference) changes.push(key);
      }
      if (changes.length > 1)
        throw new Error(`Ambiguous pipeline attribution for ${call.name} in ${file}`);
      const duplicate = calls.filter((other) => other.name === call.name).length > 1;
      if (duplicate && !call.schema)
        throw new Error(`Missing alternate schema for ${call.name} in ${file}`);
      const variant = duplicate && call.schema ? schemaVariant(call.schema) : undefined;
      const identity = JSON.stringify([call.name, variant]);
      if (variants.has(identity))
        throw new Error(`Duplicate operation identity for ${call.name} in ${file}`);
      variants.add(identity);
      routes.push({
        file,
        name: call.name,
        ...(variant ? { variant } : {}),
        verdict: changes[0] ?? 'named',
      });
    }
    if (categories.some((key) => totals[key] !== full[key]))
      throw new Error(`Inconsistent pipeline attribution in ${file}`);
  }
  if (!routes.length) throw new Error('No operation definitions found');
  return routes.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.name.localeCompare(b.name) ||
      (a.variant ?? '').localeCompare(b.variant ?? '')
  );
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    if (args.length > 1 || (args.length === 1 && args[0] !== '--strict'))
      throw new Error('Expected no arguments or --strict');
    const strict = args[0] === '--strict';
    const sources = readRepositorySources(process.cwd(), true);
    console.log(
      JSON.stringify(
        reportPipelineVerdicts(sources, (input) => countPipelineRoutes(input, strict, sources)),
        null,
        2
      )
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
