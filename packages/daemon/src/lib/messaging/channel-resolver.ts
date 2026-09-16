import type { WorkflowChannel } from '@hyperneo/shared';

export class ChannelResolver {
  constructor(private readonly channels: WorkflowChannel[]) {}

  canSend(fromNode: string, toNode: string): boolean {
    return this.channels.some((ch) => {
      if (ch.from !== fromNode && ch.from !== '*') return false;
      const toList = Array.isArray(ch.to) ? ch.to : [ch.to];
      return toList.includes(toNode) || toList.includes('*');
    });
  }

  getPermittedTargets(fromNode: string): string[] {
    const targets: string[] = [];
    for (const ch of this.channels) {
      if (ch.from !== fromNode && ch.from !== '*') continue;
      const toList = Array.isArray(ch.to) ? ch.to : [ch.to];
      targets.push(...toList);
    }
    return [...new Set(targets)];
  }

  getChannels(): WorkflowChannel[] {
    return [...this.channels];
  }

  isEmpty(): boolean {
    return this.channels.length === 0;
  }
}
