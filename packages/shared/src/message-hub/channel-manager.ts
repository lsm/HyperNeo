/**
 * ChannelManager
 *
 * Simple channel membership tracking for scoped messaging.
 * Manages which clients are members of which channels.
 */

/**
 * Channel membership manager
 */
export class ChannelManager {
  private channels: Map<string, Set<string>> = new Map(); // channel -> Set<clientId>
  private clientChannels: Map<string, Set<string>> = new Map(); // clientId -> Set<channel>

  /**
   * Add a client to a channel
   */
  joinChannel(clientId: string, channel: string): void {
    // Add channel to client's channel list
    let clientChannelSet = this.clientChannels.get(clientId);
    if (!clientChannelSet) {
      clientChannelSet = new Set();
      this.clientChannels.set(clientId, clientChannelSet);
    }
    clientChannelSet.add(channel);

    // Add client to channel's member list
    let channelMemberSet = this.channels.get(channel);
    if (!channelMemberSet) {
      channelMemberSet = new Set();
      this.channels.set(channel, channelMemberSet);
    }
    channelMemberSet.add(clientId);
  }

  /**
   * Remove a client from a channel
   */
  leaveChannel(clientId: string, channel: string): void {
    // Remove channel from client's channel list
    const clientChannelSet = this.clientChannels.get(clientId);
    if (clientChannelSet) {
      clientChannelSet.delete(channel);
      if (clientChannelSet.size === 0) {
        this.clientChannels.delete(clientId);
      }
    }

    // Remove client from channel's member list
    const channelMemberSet = this.channels.get(channel);
    if (channelMemberSet) {
      channelMemberSet.delete(clientId);
      if (channelMemberSet.size === 0) {
        this.channels.delete(channel);
      }
    }
  }

  /**
   * Get all members of a channel
   * Returns empty Set if channel doesn't exist
   */
  getChannelMembers(channel: string): Set<string> {
    return this.channels.get(channel) || new Set();
  }

  /**
   * Get all channels a client is a member of
   * Returns empty Set if client has no channels
   */
  getClientChannels(clientId: string): Set<string> {
    return this.clientChannels.get(clientId) || new Set();
  }

  /**
   * Remove a client from all channels (disconnect cleanup)
   */
  removeClient(clientId: string): void {
    const clientChannelSet = this.clientChannels.get(clientId);
    if (clientChannelSet) {
      // Remove client from all channels
      for (const channel of clientChannelSet) {
        const channelMemberSet = this.channels.get(channel);
        if (channelMemberSet) {
          channelMemberSet.delete(clientId);
          if (channelMemberSet.size === 0) {
            this.channels.delete(channel);
          }
        }
      }
      // Remove client from tracking
      this.clientChannels.delete(clientId);
    }
  }

  /**
   * Check if a client is a member of a channel
   */
  isInChannel(clientId: string, channel: string): boolean {
    const clientChannelSet = this.clientChannels.get(clientId);
    return clientChannelSet ? clientChannelSet.has(channel) : false;
  }

  /**
   * Get total number of channels
   */
  getChannelCount(): number {
    return this.channels.size;
  }

  /**
   * Get number of clients in a channel
   */
  getClientCount(channel: string): number {
    const channelMemberSet = this.channels.get(channel);
    return channelMemberSet ? channelMemberSet.size : 0;
  }
}
