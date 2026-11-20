import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { isSource } from './system-map.ts';

type Identity = { file: string; name: string; variant?: string };

export function inventoryRoutes(sources: Map<string, string>): Identity[] {
  const result: Identity[] = [];
  for (const [file, text] of sources) {
    if (!isSource(file)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const entries: { name: string; schema?: string }[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'defineOperation'
      ) {
        const arg = node.arguments[0];
        if (
          node.arguments.length !== 1 ||
          node.typeArguments?.length ||
          !ts.isObjectLiteralExpression(arg)
        )
          throw new Error(`Unsupported operation in ${file}`);
        const get = (key: string) =>
          arg.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(source) === key);
        const name = get('name');
        const schema = get('inputSchema');
        if (
          !name ||
          !ts.isPropertyAssignment(name) ||
          !ts.isStringLiteral(name.initializer) ||
          !name.initializer.text
        )
          throw new Error(`Operation name is not a literal in ${file}`);
        entries.push({
          name: name.initializer.text,
          schema:
            schema && ts.isPropertyAssignment(schema)
              ? schema.initializer.getText(source)
              : undefined,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const entry of entries) {
      const duplicate = entries.filter((other) => other.name === entry.name).length > 1;
      if (duplicate && !entry.schema)
        throw new Error(`Missing alternate schema for ${entry.name} in ${file}`);
      let variant: string | undefined;
      if (duplicate && entry.schema) {
        const scanner = ts.createScanner(
          ts.ScriptTarget.Latest,
          true,
          ts.LanguageVariant.Standard,
          entry.schema
        );
        const tokens: string[] = [];
        while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) tokens.push(scanner.getTokenText());
        variant = `schema:${createHash('sha256').update(JSON.stringify(tokens)).digest('hex')}`;
      }
      result.push({ file, name: entry.name, ...(variant ? { variant } : {}) });
    }
  }
  return result.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.name.localeCompare(b.name) ||
      (a.variant ?? '').localeCompare(b.variant ?? '')
  );
}

if (import.meta.main) {
  const files = execFileSync('git', ['ls-files', '-z', '--', 'packages'], { encoding: 'utf8' })
    .split('\0')
    .filter(isSource);
  const sources = new Map(files.map((file) => [file, readFileSync(file, 'utf8')]));
  console.log(JSON.stringify(inventoryRoutes(sources), null, 2));
}
