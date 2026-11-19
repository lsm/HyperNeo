import superpipe, { type PipelineAPI } from 'superpipe';
import { fillPrompt, NEO_RESIDENT_TOOL } from '@hyperneo/prompts';
import type { OperationName } from '@hyperneo/shared/types/operation-names';
import type { OperationRegistry } from './registry.ts';

export const NEO_RESIDENT_FAMILIES = [
  {
    name: 'neo_work',
    prefix: 'work',
    actions: ['send', 'find', 'status', 'rename', 'adapters', 'read'],
  },
  {
    name: 'neo_todo',
    prefix: 'neo.todo',
    actions: ['add', 'continue', 'edit', 'remove', 'hold', 'done', 'read'],
  },
  {
    name: 'neo_publish',
    prefix: 'neo.publication',
    actions: ['publish'],
  },
  {
    name: 'neo_ask',
    prefix: 'neo.ask',
    actions: ['read', 'settle', 'open', 'topic', 'search', 'outcome'],
  },
  {
    name: 'neo_question',
    prefix: 'neo.question',
    actions: ['ask', 'get', 'retire'],
  },
  {
    name: 'neo_session',
    prefix: 'neo.session',
    actions: ['archive'],
  },
  {
    name: 'neo_speech',
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

type ResidentFamily = (typeof NEO_RESIDENT_FAMILIES)[number];

export const residentToolDescription = (superpipe({})('neo.resident.description') as PipelineAPI)
  .input(['family', 'registry'])
  .pipe(
    (family: ResidentFamily, registry: Pick<OperationRegistry, 'get'>) =>
      family.actions.flatMap((action) => {
        const description = registry.get(residentOperation(family, action))?.description;
        return description ? [{ action, description }] : [];
      }),
    ['family', 'registry'],
    'actions'
  )
  .pipe(
    (family: ResidentFamily, actions: { action: string; description: string }[]) =>
      family.actions.length === 1
        ? (actions[0]?.description ?? '')
        : fillPrompt(NEO_RESIDENT_TOOL, {
            ACTIONS: actions
              .map(({ action, description }) => `### ${action}\n${description}`)
              .join('\n\n'),
          }),
    ['family', 'actions'],
    'description'
  )
  .end('description') as (
  family: ResidentFamily,
  registry: Pick<OperationRegistry, 'get'>
) => string;
