import { generateUUID } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import type { OapReopenEvents, OapReopenStore } from './oap-reopen.ts';

export async function announceOapNotice(
  sessionId: string,
  text: string,
  db: OapReopenStore,
  hub: OapReopenEvents,
  ensureLive: () => void
): Promise<void> {
  const message = {
    type: 'assistant',
    uuid: generateUUID(),
    session_id: sessionId,
    parent_tool_use_id: null,
    message: { role: 'assistant', content: [{ type: 'text', text, citations: null }] },
  } as unknown as SDKMessage;
  if (!(await db.saveSDKMessage(sessionId, message)))
    throw new Error('Could not save the Codex recovery notice');
  ensureLive();
  hub.event(
    'state.sdkMessages.delta',
    { added: [message], timestamp: Date.now() },
    { channel: `session:${sessionId}` }
  );
}
