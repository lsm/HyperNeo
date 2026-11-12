import type { OperationName } from '@hyperneo/shared/types/operation-names';

export const NEO_RESIDENT_FAMILIES = [
  {
    name: 'neo_work',
    description: 'Route and inspect work. send takes ref and message.',
    prefix: 'work',
    actions: ['send', 'find', 'status', 'rename', 'adapters', 'read'],
  },
  {
    name: 'neo_todo',
    description: 'Manage todos. add needs title/check; continue needs todoId/message.',
    prefix: 'neo.todo',
    actions: [
      'add',
      'continue',
      'edit',
      'remove',
      'hold',
      'done',
      'close',
      'bind',
      'retry',
      'proceed',
    ],
  },
  {
    name: 'neo_publish',
    description: 'Publish shortText/fullText with stable requestId.',
    prefix: 'neo.publication',
    actions: ['publish'],
  },
  {
    name: 'neo_ask',
    description: 'Manage asks. open needs title/request; settle needs outcome.',
    prefix: 'neo.ask',
    actions: ['read', 'settle', 'open', 'topic', 'search', 'outcome'],
  },
  {
    name: 'neo_question',
    description: 'Manage human cards. ask needs kind/text; get needs questionId.',
    prefix: 'neo.question',
    actions: ['ask', 'get', 'retire', 'relay'],
  },
  {
    name: 'neo_session',
    description: 'Archive a session by ref.',
    prefix: 'neo.session',
    actions: ['archive'],
  },
  {
    name: 'neo_speech',
    description: 'Speak text with a stable requestId.',
    prefix: 'neo.speech',
    actions: ['say'],
  },
] as const;

export function residentOperation(
  family: (typeof NEO_RESIDENT_FAMILIES)[number],
  action: string = family.actions[0]
): OperationName {
  return `${family.prefix}.${action}` as OperationName;
}
