import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diffSchemas, type ApiChange, type ChangeLevel } from './api-diff-schema.ts';
export type ApiSurface = {
  operations: { name: string; inputSchema: unknown; resultSchema: unknown }[];
  events: string[];
  eventSchemas?: Record<string, unknown>;
};

export function diffApiSurfaces(
  before: ApiSurface,
  after: ApiSurface,
  phone: readonly string[]
): ApiChange[] {
  const index = (surface: ApiSurface) => {
    const map = new Map(surface.operations.map((op) => [op.name, op]));
    if (map.size !== surface.operations.length) throw new Error('Duplicate operation names');
    return map;
  };
  const old = index(before),
    next = index(after),
    used = new Set(phone);
  const changes: ApiChange[] = [];
  const emit = (operation: string, path: string, level: ChangeLevel, message: string) =>
    changes.push({ operation, path, level, message, phoneUsed: used.has(operation) });
  for (const name of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const a = old.get(name),
      b = next.get(name);
    if (!a) emit(name, 'operation', 'safe', 'Operation added');
    else if (!b) emit(name, 'operation', 'breaking', 'Operation removed');
    else
      for (const side of ['input', 'result'] as const)
        diffSchemas(a[`${side}Schema`], b[`${side}Schema`], side, (path, level, message) =>
          emit(name, path, level, message)
        );
  }
  for (const name of [...new Set([...before.events, ...after.events])].sort()) {
    if (!after.events.includes(name))
      emit(name, 'event', 'breaking', 'Server event method removed');
    if (!before.events.includes(name)) emit(name, 'event', 'safe', 'Server event method added');
    const a = before.eventSchemas?.[name],
      b = after.eventSchemas?.[name];
    if (a !== undefined && b !== undefined)
      diffSchemas(a, b, 'result', (path, level, message) =>
        emit(name, path.replace(/^result/, 'event.data'), level, message)
      );
    else if (a !== undefined) emit(name, 'event.data', 'breaking', 'Event payload schema removed');
    else if (b !== undefined)
      changes.push({
        operation: name,
        path: 'event.data',
        level: 'safe',
        phoneUsed: used.has(name),
        coverageOnly: true,
        message:
          'Payload schema recorded; prior payload was untracked, so historical compatibility is not asserted',
      });
  }
  return changes.sort(
    (a, b) =>
      a.operation.localeCompare(b.operation) ||
      a.path.localeCompare(b.path) ||
      a.level.localeCompare(b.level) ||
      a.message.localeCompare(b.message)
  );
}
export function formatApiDiff(previous: string, current: string, changes: ApiChange[]): string {
  const count = (entries: ApiChange[]) =>
    ['breaking', 'risky', 'safe']
      .map((level) => `${entries.filter((c) => c.level === level).length} ${level}`)
      .join(', ');
  const highest = new Map<string, ApiChange>();
  const severity = { safe: 0, risky: 1, breaking: 2 };
  for (const change of changes.filter((c) => c.phoneUsed && !c.coverageOnly))
    if (
      !highest.has(change.operation) ||
      severity[change.level] > severity[highest.get(change.operation)!.level]
    )
      highest.set(change.operation, change);
  return `${previous} -> ${current}: phone-used operations: ${count([...highest.values()])}\n\nAll changes: ${count(changes)}. Phone operation counts use each method's highest severity; coverage-only additions are excluded.\n\n${changes.length ? changes.map((c) => `- ${c.level}${c.phoneUsed ? ' [phone]' : ''}${c.coverageOnly ? ' [coverage only]' : ''}: ${c.operation} ${c.path} — ${c.message}`).join('\n') : 'No API surface changes.'}\n`;
}
async function main(): Promise<void> {
  const args = process.argv.slice(2),
    refs: string[] = [];
  let phoneFile = resolve(import.meta.dir, '../api-phone-methods.json'),
    json = false,
    worktreeRoot: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--phone-methods' && args[i + 1]) phoneFile = resolve(args[++i]!);
    else if (args[i] === '--worktree-root' && args[i + 1]) worktreeRoot = resolve(args[++i]!);
    else if (args[i]!.startsWith('-'))
      throw new Error(
        'Usage: bun run api:diff <previous-ref> [current-ref] [--phone-methods file] [--json]'
      );
    else refs.push(args[i]!);
  }
  if (refs.length < 1 || refs.length > 2)
    throw new Error(
      'Usage: bun run api:diff <previous-ref> [current-ref] [--phone-methods file] [--json]'
    );
  const phone = JSON.parse(readFileSync(phoneFile, 'utf8')) as {
    sourceCommit: string;
    methods: string[];
    events?: string[];
    sourceEvidence?: string;
  };
  if (
    !phone.sourceCommit ||
    !Array.isArray(phone.methods) ||
    phone.methods.some((name) => typeof name !== 'string')
  )
    throw new Error('Invalid phone method inventory');
  const { surfaceAtRef } = await import('./api-surface-history.ts');
  const before = await surfaceAtRef(refs[0]!, worktreeRoot);
  const after = refs[1]
    ? await surfaceAtRef(refs[1], worktreeRoot)
    : {
        ref: 'working snapshot',
        commit: null,
        surface: JSON.parse(
          readFileSync(resolve(import.meta.dir, '../api-surface.json'), 'utf8')
        ) as ApiSurface,
        collected: false,
      };
  const changes = diffApiSurfaces(before.surface, after.surface, [
    ...phone.methods,
    ...(phone.events ?? []),
  ]);
  const report = `${formatApiDiff(before.ref, after.ref, changes)}\nPhone inventory source: ${phone.sourceCommit}.\n${phone.sourceEvidence ?? 'Source inventory only; installed binary-to-source provenance was not supplied.'}\n`;
  const metadata = ({ surface, ...rest }: typeof before | typeof after) => ({
    ...rest,
    operations: surface.operations.length,
    events: surface.events.length,
    eventSchemas: Object.keys(surface.eventSchemas ?? {}).length,
  });
  if (json)
    console.log(
      JSON.stringify(
        { before: metadata(before), after: metadata(after), phone, changes, report },
        null,
        2
      )
    );
  else console.log(report);
}
if (import.meta.main) await main();
