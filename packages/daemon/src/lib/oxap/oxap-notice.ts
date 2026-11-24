import { generateUUID } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { OxapReopenEvents, OxapReopenStore } from './oxap-reopen.ts';

export async function announceOxapNotice(
  sessionId: string,
  text: string,
  db: OxapReopenStore,
  hub: OxapReopenEvents,
  ensureLive: () => void
): Promise<void> {
  const message = {
    type: 'assistant',
    uuid: generateUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text, citations: null }] },
  } as unknown as SDKMessage;
  await publishOxapMessage(sessionId, message, db, hub, ensureLive);
}

export async function publishOxapMessage(
  sessionId: string,
  message: SDKMessage,
  db: OxapReopenStore,
  hub: OxapReopenEvents,
  ensureLive: () => void
): Promise<void> {
  ensureLive();
  if (!(await db.saveSDKMessage(sessionId, message)))
    throw new Error('Could not save the OXAP chat message');
  ensureLive();
  hub.event(
    'state.sdkMessages.delta',
    { added: [message], timestamp: Date.now() },
    { channel: `session:${sessionId}` }
  );
}
