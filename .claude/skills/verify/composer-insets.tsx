import { render } from 'preact';
import { signal } from '@preact/signals';
import { NeoComposer } from '../../../packages/web/src/neo/NeoComposer.tsx';
import type { SessionStore } from '../../../packages/web/src/lib/session-store.ts';
const pending = new URL(location.href).searchParams.has('pending');
const store = {
  sdkMessages: signal([]), agentState: signal({ status: 'idle' }),
  sessionInfo: signal({ config: { model: 'synthetic' }, metadata: pending ? { pendingModelSwitch: { model: 'synthetic-next-model', provider: 'anthropic', requestedAt: 1 } } : {} }),
  hasMoreMessages: signal(false), error: signal(null), isWorking: signal(pending), refresh: async () => {},
} as unknown as SessionStore;
File.prototype.text = () => new Promise<string>(() => {});
render(<main class="neo-shell p-3"><h1>Synthetic composer auxiliary rows</h1>
  <NeoComposer store={store} sessionId="synthetic-insets" draft="Synthetic draft" onDraft={() => {}}
    onStop={pending ? () => {} : undefined}
    onError={() => {}} onTranscript={() => {}} onSend={async () => ({ ok: false, reason: 'Synthetic fixture never sends' })}
    quote={{ author: 'Neo', text: 'Synthetic quoted summary', anchor: 'synthetic' }}
    previewContext={{ artifactId: 'bound', snapshot: '00000000', displayName: 'Bound preview', state: 'available' }}
    previewCandidate={{ artifactId: 'candidate', snapshot: '11111111', displayName: 'New preview', state: 'available' }}
    onRebindPreview={() => {}} />
</main>, document.getElementById('root')!);
