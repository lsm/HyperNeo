import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { inventoryRoutes } from './pipeline-route-inventory.ts';
import { reportPipelineVerdicts } from './pipeline-verdict-report.ts';
import { readRepositorySources } from './system-map.ts';

test('independent inventory accounts for every reported operation', () => {
  const sources = readRepositorySources(process.cwd(), true);
  const inventory = inventoryRoutes(sources);
  const report = reportPipelineVerdicts(sources).map(({ file, name, variant }) => ({
    file,
    name,
    ...(variant ? { variant } : {}),
  }));
  expect(inventory.length).toBeGreaterThan(0);
  expect(inventory).toEqual(report);
  expect(inventory.slice(1)).not.toEqual(report);
});

test('inventory distinguishes alternate schemas and rejects missing variants', () => {
  const file = 'packages/demo/src/operations.ts';
  const source =
    "defineOperation({ name: 'demo.read', inputSchema: a }); defineOperation({ name: 'demo.read', inputSchema: b });";
  const routes = inventoryRoutes(new Map([[file, source]]));
  expect(routes).toHaveLength(2);
  expect(routes[0].variant).not.toBe(routes[1].variant);
  expect(() =>
    inventoryRoutes(new Map([[file, source.replace('inputSchema: b', 'description: b')]]))
  ).toThrow('Missing alternate schema');
});

test('database registrations and SDK operation names are statically readable', () => {
  const registry = readFileSync('packages/daemon/src/storage/db-gateway/db-ops.ts', 'utf8');
  const ops = readFileSync(
    'packages/daemon/src/storage/repositories/sdk-message-transactions.ts',
    'utf8'
  );
  const source = ts.createSourceFile('registry.ts', registry, ts.ScriptTarget.Latest, true);
  let elements: ts.NodeArray<ts.Expression> | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === 'DB_OPS' &&
      node.initializer &&
      ts.isNewExpression(node.initializer)
    ) {
      const map = node.initializer.arguments?.[0];
      if (
        map &&
        ts.isCallExpression(map) &&
        ts.isPropertyAccessExpression(map.expression) &&
        ts.isArrayLiteralExpression(map.expression.expression)
      )
        elements = map.expression.expression.elements;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  expect(elements).toBeDefined();
  expect(elements?.every(ts.isIdentifier)).toBe(true);
  const definitions = ts.createSourceFile('ops.ts', ops, ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const find = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'defineDbOp'
    ) {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        const property = arg.properties.find(
          (p) => ts.isPropertyAssignment(p) && p.name.getText(definitions) === 'name'
        );
        if (
          property &&
          ts.isPropertyAssignment(property) &&
          ts.isStringLiteral(property.initializer)
        )
          names.push(property.initializer.text);
      }
    }
    ts.forEachChild(node, find);
  };
  find(definitions);
  expect(names).toHaveLength(11);
  expect(names.every((name) => name.startsWith('sdk_messages.'))).toBe(true);
});
