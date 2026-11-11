import type { OperationName } from '@hyperneo/shared/types/operation-names';

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
