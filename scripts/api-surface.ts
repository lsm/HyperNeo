import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { z } from '../packages/daemon/node_modules/zod/index.js';
import type { OperationDefinition } from '../packages/daemon/src/lib/operations/registry.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)])
    );
  return value;
}

export function serializeApiSurface(
  operations: readonly OperationDefinition[],
  events: readonly string[],
  names: readonly string[],
  eventSchemas?: Readonly<Record<string, z.ZodType>>
): string {
  const actual = new Set(operations.map((operation) => operation.name));
  const missing = names.filter((name) => !actual.has(name));
  const extra = [...actual].filter((name) => !names.includes(name));
  if (missing.length || extra.length || actual.size !== operations.length)
    throw new Error(
      `Incomplete operation catalog: missing ${missing.join(', ')}; unexpected ${extra.join(', ')}; duplicate names ${operations.length - actual.size}`
    );
  const entries = [...operations]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((operation) => {
      const schema = (definition: z.ZodType, io: 'input' | 'output') =>
        z.toJSONSchema(definition, {
          io,
          unrepresentable: ({ zodSchema, message }) => ({
            'x-zod-unrepresentable': message,
            ...(zodSchema._zod.def.type === 'transform'
              ? {
                  'x-zod-transform-sha256': createHash('sha256')
                    .update(String(zodSchema._zod.def.transform))
                    .digest('hex'),
                }
              : {}),
          }),
        });
      return {
        name: operation.name,
        inputSchema: schema(operation.inputSchema, 'input'),
        resultSchema: schema(operation.resultSchema, 'output'),
      };
    });
  const exportedEvents: Record<string, unknown> = {};
  for (const [method, definition] of Object.entries(eventSchemas ?? {})) {
    if (!events.includes(method)) throw new Error(`Unadvertised event schema: ${method}`);
    exportedEvents[method] = z.toJSONSchema(definition, { io: 'input' });
  }
  return `${JSON.stringify(canonical({ operations: entries, events: [...new Set(events)].sort(), ...(eventSchemas ? { eventSchemas: exportedEvents } : {}) }), null, 2)}\n`;
}

export function clientEventMethods(program: ts.Program, files: readonly string[]): string[] {
  const checker = program.getTypeChecker();
  const methods = new Set<string>();
  const strings = (node: ts.Expression): string[] => {
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isTemplateExpression(node)) {
      let values = [node.head.text];
      for (const span of node.templateSpans)
        values = values.flatMap((prefix) =>
          strings(span.expression).map((value) => prefix + value + span.literal.text)
        );
      return values;
    }
    const value =
      ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : undefined;
    const type = value
      ? checker.getTypeOfSymbolAtLocation(value, node)
      : checker.getTypeAtLocation(node);
    const types = type.isUnion() ? type.types : [type];
    if (types.every((t) => t.isStringLiteral()))
      return types.map((t) => (t as ts.StringLiteralType).value);
    throw new Error(`Unresolved client event method: ${node.getText()}`);
  };
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) throw new Error('Missing event source');
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        ((ts.isIdentifier(node.expression) && node.expression.text === 'createEventMessage') ||
          (ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'createEventMessage'))
      ) {
        const argument = node.arguments[0];
        if (!argument) throw new Error('Unresolved client event method');
        const property = ts.isObjectLiteralExpression(argument)
          ? argument.properties.find(
              (p) =>
                (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
                p.name.getText(source).replace(/^['"]|['"]$/g, '') === 'method'
            )
          : undefined;
        if (property && ts.isPropertyAssignment(property))
          strings(property.initializer).forEach((method) => methods.add(method));
        else if (property && ts.isShorthandPropertyAssignment(property))
          strings(property.name).forEach((method) => methods.add(method));
        else {
          const member = checker.getTypeAtLocation(argument).getProperty('method');
          if (!member) throw new Error('Unresolved client event method');
          const type = checker.getTypeOfSymbolAtLocation(member, argument);
          const values = type.isUnion() ? type.types : [type];
          if (!values.every((value) => value.isStringLiteral()))
            throw new Error('Unresolved client event method');
          values.forEach((value) => methods.add((value as ts.StringLiteralType).value));
        }
      }
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'clientEvent')
        strings(node.initializer).forEach((method) => methods.add(method));
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const name = node.expression.name.text;
        const receiver = checker
          .getTypeAtLocation(node.expression.expression)
          .getSymbol()
          ?.getName();
        if (
          name === 'event' ||
          ((name === 'publish' || name === 'publishGlobal') &&
            ['IClientEventGateway', 'ClientEventGateway'].includes(receiver ?? ''))
        ) {
          const method = node.arguments[0];
          if (!method || ts.isSpreadElement(method))
            throw new Error('Unresolved client event method');
          if (!(ts.isPropertyAccessExpression(method) && method.name.text === 'clientEvent'))
            strings(method).forEach((value) => methods.add(value));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...methods].sort();
}

export function saveApiSurface(path: string, generated: string, check: boolean): void {
  if (!check) {
    writeFileSync(path, generated);
    return;
  }
  let committed: string | undefined;
  try {
    committed = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (committed !== generated)
    throw new Error('API surface changed. Run bun run api:surface and commit api-surface.json.');
}

async function collect(run: string, root: string): Promise<void> {
  if (
    process.env.HOME !== join(run, 'home') ||
    process.env.HYPERNEO_DATA_DIR !== join(run, 'data') ||
    process.env.NODE_ENV !== 'test'
  )
    throw new Error('API collection requires an isolated test home and database');
  globalThis.fetch = (() => {
    throw new Error('External HTTP disabled for API collection');
  }) as typeof fetch;
  const { createDaemonApp } = await import(join(root, 'packages/daemon/src/app.ts'));
  const { getConfig } = await import(join(root, 'packages/daemon/src/config.ts'));
  const { OPERATION_NAMES } = await import(
    join(root, 'packages/shared/src/types/operation-names.ts')
  );
  const schemasPath = join(root, 'packages/daemon/src/lib/operations/client-event-schemas.ts');
  const eventSchemas = existsSync(schemasPath)
    ? (await import(schemasPath)).CLIENT_EVENT_SCHEMAS
    : undefined;
  const app = await createDaemonApp({
    config: {
      ...getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }),
      disableWorktrees: true,
      disableGoalProcessing: true,
    },
    verbose: false,
  });
  try {
    await app.spaceRuntimeService.ready();
    await app.jobProcessor.stop();
    const operations = app.sessionManager.getOperationRegistry().entries;
    writeFileSync(
      join(run, 'operations.json'),
      serializeApiSurface(
        operations,
        Object.keys(eventSchemas ?? {}),
        OPERATION_NAMES,
        eventSchemas
      )
    );
  } finally {
    await app.cleanup();
  }
}

export async function generateApiSurface(root = resolve(import.meta.dir, '..')): Promise<string> {
  const run = mkdtempSync(join(tmpdir(), 'hyperneo-api-surface-'));
  try {
    for (const dir of ['home', 'data', 'tmp', 'bin']) mkdirSync(join(run, dir));
    writeFileSync(join(run, 'bin/gh'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    const child = Bun.spawnSync([process.execPath, import.meta.path, '--collect', run, root], {
      cwd: root,
      env: {
        HOME: join(run, 'home'),
        HYPERNEO_DATA_DIR: join(run, 'data'),
        TMPDIR: join(run, 'tmp'),
        NODE_ENV: 'test',
        HYPERNEO_SPACE: 'on',
        LOG_LEVEL: 'error',
        PATH: `${join(run, 'bin')}:${process.env.PATH ?? ''}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60000,
    });
    if (child.exitCode !== 0)
      throw new Error(
        `API catalog collection failed:\n${child.stderr.toString()}${child.stdout.toString()}`
      );
    const surface = JSON.parse(readFileSync(join(run, 'operations.json'), 'utf8'));
    const config = ts.readConfigFile(join(root, 'packages/daemon/tsconfig.json'), ts.sys.readFile);
    if (config.error) throw new Error('Cannot read daemon TypeScript configuration');
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      join(root, 'packages/daemon')
    );
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    const files = parsed.fileNames.filter(
      (file) => file.startsWith(join(root, 'packages/daemon/src') + '/') && !file.endsWith('.d.ts')
    );
    surface.events = clientEventMethods(program, files);
    for (const method of Object.keys(surface.eventSchemas ?? {}))
      if (!surface.events.includes(method)) throw new Error(`Unadvertised event schema: ${method}`);
    const phonePath = join(root, 'api-phone-methods.json');
    const required = existsSync(phonePath)
      ? (JSON.parse(readFileSync(phonePath, 'utf8')).events ?? [])
      : [];
    for (const method of required)
      if (!(method in (surface.eventSchemas ?? {})))
        throw new Error(`Missing phone event payload schema: ${method}`);
    const generated = `${JSON.stringify(canonical(surface), null, 2)}\n`;
    return generated;
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const root = resolve(import.meta.dir, '..');
  if (args[0] === '--collect' && args.length >= 2 && args.length <= 3)
    return collect(resolve(args[1]!), args[2] ? resolve(args[2]) : root);
  if (args.length && !(args.length === 1 && args[0] === '--check'))
    throw new Error('Usage: bun run api:surface [--check]');
  const generated = await generateApiSurface(root);
  const surface = JSON.parse(generated);
  saveApiSurface(join(root, 'api-surface.json'), generated, args[0] === '--check');
  console.log(
    `API surface ${args[0] === '--check' ? 'matches' : 'written'}: ${surface.operations.length} operations, ${surface.events.length} client events.`
  );
}

if (import.meta.main) await main();
