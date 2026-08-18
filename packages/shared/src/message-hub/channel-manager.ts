export class ChannelManager {
  private channels: Map<string, Set<string>> = new Map();
  private clientChannels: Map<string, Set<string>> = new Map();

  joinChannel(clientId: string, channel: string): void {
    let clientChannelSet = this.clientChannels.get(clientId);
    if (!clientChannelSet) {
      clientChannelSet = new Set();
      this.clientChannels.set(clientId, clientChannelSet);
    }
    clientChannelSet.add(channel);

    let channelMemberSet = this.channels.get(channel);
    if (!channelMemberSet) {
      channelMemberSet = new Set();
      this.channels.set(channel, channelMemberSet);
    }
    channelMemberSet.add(clientId);
  }

  leaveChannel(clientId: string, channel: string): void {
    const clientChannelSet = this.clientChannels.get(clientId);
    if (clientChannelSet) {
      clientChannelSet.delete(channel);
      if (clientChannelSet.size === 0) {
        this.clientChannels.delete(clientId);
      }
    }

    const channelMemberSet = this.channels.get(channel);
    if (channelMemberSet) {
      channelMemberSet.delete(clientId);
      if (channelMemberSet.size === 0) {
        this.channels.delete(channel);
      }
    }
  }

  getChannelMembers(channel: string): Set<string> {
    return this.channels.get(channel) || new Set();
  }

  getClientChannels(clientId: string): Set<string> {
    return this.clientChannels.get(clientId) || new Set();
  }

  removeClient(clientId: string): void {
    const clientChannelSet = this.clientChannels.get(clientId);
    if (clientChannelSet) {
      for (const channel of clientChannelSet) {
        const channelMemberSet = this.channels.get(channel);
        if (channelMemberSet) {
          channelMemberSet.delete(clientId);
          if (channelMemberSet.size === 0) {
            this.channels.delete(channel);
          }
        }
      }
      this.clientChannels.delete(clientId);
    }
  }

  isInChannel(clientId: string, channel: string): boolean {
    const clientChannelSet = this.clientChannels.get(clientId);
    return clientChannelSet ? clientChannelSet.has(channel) : false;
  }

  getChannelCount(): number {
    return this.channels.size;
  }

  getClientCount(channel: string): number {
    const channelMemberSet = this.channels.get(channel);
    return channelMemberSet ? channelMemberSet.size : 0;
  }
}
