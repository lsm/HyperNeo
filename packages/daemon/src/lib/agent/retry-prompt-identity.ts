import { randomUUID } from 'node:crypto';
import type { SDKMessage, SDKUserMessage } from '@hyperneo/shared/sdk';

export class RetryPromptIdentity {
  private readonly pending = new Set<string>();
  private readonly original = new Map<string, string>();

  retry(uuid: string): void {
    this.pending.add(uuid);
  }

  outgoing(message: SDKUserMessage, fresh = false): SDKUserMessage {
    if (!message.uuid) return message;
    const retry = this.pending.delete(message.uuid);
    if (!fresh && !retry) return message;
    const uuid = randomUUID();
    this.original.set(uuid, message.uuid);
    return { ...message, uuid };
  }

  incoming(message: SDKMessage): SDKMessage {
    if (!this.original.size) return message;
    const refs = message as SDKMessage & {
      parent_tool_use_id?: string | null;
      user_message_uuid?: string;
      user_message_uuids?: string[];
    };
    if (
      !(message.type === 'user' && message.uuid && this.original.has(message.uuid)) &&
      !(refs.user_message_uuid && this.original.has(refs.user_message_uuid)) &&
      !refs.user_message_uuids?.some((id) => this.original.has(id))
    )
      return message;
    const incoming = {
      ...message,
      ...(message.type === 'user' && message.uuid
        ? { uuid: this.original.get(message.uuid) ?? message.uuid }
        : {}),
      ...(refs.user_message_uuid
        ? { user_message_uuid: this.original.get(refs.user_message_uuid) ?? refs.user_message_uuid }
        : {}),
      ...(refs.user_message_uuids
        ? { user_message_uuids: refs.user_message_uuids.map((id) => this.original.get(id) ?? id) }
        : {}),
    } as SDKMessage;
    if (message.type === 'result' && !refs.parent_tool_use_id) {
      if (refs.user_message_uuid) this.original.delete(refs.user_message_uuid);
      for (const id of refs.user_message_uuids ?? []) this.original.delete(id);
    }
    return incoming;
  }
}
