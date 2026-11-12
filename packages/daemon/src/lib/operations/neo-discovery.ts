import { z } from 'zod';
import type { OperationName } from '@hyperneo/shared/types/operation-names';

export const NEO_RARE_OPERATION_NAMES = [
  'artifact.file.get',
  'artifact.file.html',
  'artifact.file.list',
  'artifact.file.read',
  'artifact.reference.resolve',
  'calendar.list',
  'daemon.session.inspect',
  'daemon.snapshot',
  'event.external.delivery.list',
  'event.external.get',
  'event.external.subscribe',
  'event.external.subscription.list',
  'event.external.unsubscribe',
  'file.handoff.read',
  'gmail.draft',
  'gmail.read_thread',
  'gmail.search',
  'goal.facts',
  'goal.journal.append',
  'goal.journal.list',
  'goal.session.create',
  'goal.session.get',
  'goal.session.list',
  'goal.session.update',
  'google.accounts',
  'handoff.publish',
  'handoff.read',
  'message.send',
  'message.status',
  'neo.ask.doneTodos',
  'neo.ask.history',
  'neo.coding.assign',
  'neo.coding.merge.human',
  'neo.coding.merge.prepare',
  'neo.coding.merge.retry',
  'neo.coding.pr.file',
  'neo.coding.result',
  'neo.coding.smoke',
  'neo.conversation.asks.read',
  'neo.conversation.image.read',
  'neo.conversation.read',
  'neo.home.github',
  'neo.home.init',
  'neo.home.read',
  'neo.home.save',
  'neo.pack.read',
  'neo.peer.accept',
  'neo.peer.invite',
  'neo.peer.list',
  'neo.peer.remove',
  'neo.peer.send',
  'neo.project.forget',
  'neo.project.move',
  'neo.project.save',
  'neo.project.section',
  'neo.projects.reorganize',
  'neo.publication.read',
  'neo.question.resolve',
  'neo.relaySenders.recent',
  'neo.rule.applyAnswer',
  'neo.rule.ask',
  'neo.rule.save',
  'neo.session.link',
  'neo.session.mute',
  'neo.snapshot',
  'pack.preferences.applyAnswer',
  'pack.preferences.ask',
  'pack.preferences.get',
  'pack.preferences.list',
  'schedule.session.create',
  'schedule.session.delete',
  'schedule.session.list',
  'schedule.session.pause',
  'schedule.session.resume',
  'work.health',
  'work.project.addFolder',
  'work.queue',
  'work.start',
  'work.stop',
  'work.turns',
  'work.withdraw',
] as const satisfies readonly OperationName[];

const rareOperations = new Set<string>(NEO_RARE_OPERATION_NAMES);

export const CompactDiscoverySchema = z.union([
  z.object({
    prefixes: z.array(z.object({ prefix: z.string(), count: z.number().int().nonnegative() })),
  }),
  z.object({
    total: z.number().int().nonnegative(),
    names: z.array(z.string()).max(20),
    next: z.string().nullable(),
  }),
]);

export function neoRareNames(operations: readonly { name: string }[]): string[] {
  return operations
    .map(({ name }) => name)
    .filter((name) => rareOperations.has(name))
    .sort();
}

export function compactNeoDiscovery(
  operations: readonly { name: string }[],
  prefix?: string,
  cursor?: string
): z.infer<typeof CompactDiscoverySchema> {
  const names = neoRareNames(operations);
  if (prefix === undefined) {
    const counts = new Map<string, number>();
    for (const name of names) {
      const namespace = name.split('.')[0];
      counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
    }
    return { prefixes: [...counts].map(([prefix, count]) => ({ prefix, count })) };
  }
  const namespace = prefix.replace(/\.$/, '');
  const matched = names.filter((name) => name.startsWith(`${namespace}.`));
  const page = matched.filter((name) => cursor === undefined || name > cursor);
  return {
    total: matched.length,
    names: page.slice(0, 20),
    next: page.length > 20 ? page[19] : null,
  };
}
