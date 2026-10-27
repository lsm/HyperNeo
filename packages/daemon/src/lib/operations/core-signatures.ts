import { operationSignature } from './discovery.ts';
import type { OperationRegistry } from './registry.ts';

const rules = {
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
} as const;

export function coreOperationSignatures(registry: OperationRegistry): string {
  let block = Object.entries(rules)
    .flatMap(([name, rule]) => {
      const operation = registry.get(name);
      return operation ? [`${operationSignature(operation, true)}; ${rule}`] : [];
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
