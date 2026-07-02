/**
 * ChannelResolver — validates messaging permissions based on declared channel topology.
 *
 * Accepts a `WorkflowChannel[]` and exposes a simple validation API for checking
 * whether a given node is permitted to send messages to another node.
 *
 * Channels are node-to-node (WorkflowChannel.from/to = WorkflowNode.name) and are
 * always one-way. A bidirectional relationship is represented as two separate channels.
 *
 * When no channels are declared (empty array), all `canSend()` calls return `false`.
 */

import type { WorkflowChannel } from '@hyperneo/shared';

export class ChannelResolver {
  constructor(private readonly channels: WorkflowChannel[]) {}

  /**
   * Returns true if the declared channel topology permits the sender node to message
   * the target node. `from` and `to` are node names (WorkflowNode.name).
   *
   * When no channels are declared, always returns false.
   */
  canSend(fromNode: string, toNode: string): boolean {
    return this.channels.some((ch) => {
      if (ch.from !== fromNode && ch.from !== '*') return false;
      const toList = Array.isArray(ch.to) ? ch.to : [ch.to];
      return toList.includes(toNode) || toList.includes('*');
    });
  }

  /**
   * Returns all target node names that the given sender node is permitted to message.
   * Returns an empty array when no channels are declared or none match.
   */
  getPermittedTargets(fromNode: string): string[] {
    const targets: string[] = [];
    for (const ch of this.channels) {
      if (ch.from !== fromNode && ch.from !== '*') continue;
      const toList = Array.isArray(ch.to) ? ch.to : [ch.to];
      targets.push(...toList);
    }
    return [...new Set(targets)];
  }

  /**
   * Returns a shallow copy of the channel definitions.
   */
  getChannels(): WorkflowChannel[] {
    return [...this.channels];
  }

  /** True when no channels are declared (open topology — no routing constraints). */
  isEmpty(): boolean {
    return this.channels.length === 0;
  }
}
