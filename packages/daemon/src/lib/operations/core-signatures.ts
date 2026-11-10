import type { OperationName } from '@hyperneo/shared/types/operation-names';
import { operationSignature } from './discovery.ts';
import { isOperationAdmitted } from './invoke.ts';
import { enabledOperationPacks, type OperationRegistry } from './registry.ts';

const rules = {
  'neo.speech.say':
    'requestId is stable on retry; text is a natural spoken reply, not the screen text',
  'work.send': 'ref is an object; message, not text',
  'neo.publication.publish': 'shortText and fullText required',
  'neo.todo.add': 'instruction and target pair unless bind; start needs target',
  'neo.todo.continue': 'message required',
  'neo.todo.edit': 'done is an enum, not boolean',
  'neo.github.read': 'exactly one of url|repo',
  'neo.question.ask': 'choice needs 2–6 options; yesno needs both labels',
  'neo.ask.settle': 'outcome required, ≤500 chars',
  'neo.snapshot': 'sinceRev is a string',
  'work.find': 'limit is 1–50',
  'neo.ask.open': 'request required, not just title',
  'neo.todo.close': 'reason required; closure is unverified',
  'neo.question.get': 'questionId, not askId',
  'work.status': 'read current work status',
  'work.read': 'read current work content',
  'work.rename': 'rename work',
  'work.adapters': 'discover available work adapters',
  'neo.todo.remove': 'remove a todo',
  'neo.todo.hold': 'hold a todo',
  'neo.todo.bind': 'bind existing work to a todo',
  'neo.todo.retry': 'retry a todo',
  'neo.todo.proceed': 'proceed with a todo',
  'neo.ask.read': 'read an ask',
  'neo.ask.topic': 'set the ask topic',
  'neo.ask.search': 'search asks',
  'neo.ask.outcome': 'record the ask outcome',
  'neo.question.retire': 'retire a question',
  'neo.question.relay': 'preserve the human answer and its source',
  'neo.session.archive': 'archive a session',
} as const satisfies Partial<Record<OperationName, string>>;

export const NEO_CORE_OPERATION_NAMES = Object.keys(rules);

export function coreOperationSignatures(registry: OperationRegistry): string {
  const enabled = enabledOperationPacks(registry);
  let block = Object.entries(rules)
    .flatMap(([name, rule]) => {
      const operation = registry.get(name);
      return operation && isOperationAdmitted(operation, { source: 'mcp', role: 'neo' }, enabled)
        ? [`${operationSignature(operation, true)}; ${rule}`]
        : [];
    })
    .join('\n');
  if (!block) return '';
  const objects = new Set<string>();
  const starts: number[] = [];
  for (let i = 0; i < block.length; i++) {
    if (block[i] === '{') starts.push(i);
    if (block[i] === '}') {
      const start = starts.pop()!;
      const shape = block.slice(start, i + 1);
      objects.add(shape);
    }
  }
  const aliases: string[] = [];
  for (const shape of [...objects].sort((a, b) => b.length - a.length)) {
    const count = block.split(shape).length - 1;
    const alias = `T${aliases.length + 1}`;
    if ((count - 1) * shape.length <= (count + 1) * alias.length + 2) continue;
    block = block.replaceAll(shape, alias);
    aliases.push(`${alias}=${shape}`);
  }
  return `Untyped fields: string; ?: optional; &: combine.\n${aliases.join('\n')}${aliases.length ? '\n' : ''}${block}`;
}
