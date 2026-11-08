import { render } from 'preact';
import { signal } from '@preact/signals';
import { NeoComposer } from '../../../packages/web/src/neo/NeoComposer.tsx';
import type { SessionStore } from '../../../packages/web/src/lib/session-store.ts';
const store = {
  sdkMessages: signal([]), agentState: signal({ status: 'idle' }),
  sessionInfo: signal({ config: { model: 'synthetic' }, metadata: {} }),
  hasMoreMessages: signal(false), error: signal(null), isWorking: signal(false), refresh: async () => {},
} as unknown as SessionStore;
File.prototype.text = () => new Promise<string>(() => {});
render(<main class="neo-shell p-3"><h1>Synthetic composer auxiliary rows</h1>
  <NeoComposer store={store} sessionId="synthetic-insets" draft="Synthetic draft" onDraft={() => {}}
    onError={() => {}} onTranscript={() => {}} onSend={async () => ({ ok: false, reason: 'Synthetic fixture never sends' })}
    quote={{ author: 'Neo', text: 'Synthetic quoted summary', anchor: 'synthetic' }}
    previewContext={{ artifactId: 'bound', snapshot: '00000000', displayName: 'Bound preview', state: 'available' }}
    previewCandidate={{ artifactId: 'candidate', snapshot: '11111111', displayName: 'New preview', state: 'available' }}
    onRebindPreview={() => {}} />
</main>, document.getElementById('root')!);
