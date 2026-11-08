import { render } from 'preact';
import { signal } from '@preact/signals';
import { NeoComposer } from '../../../packages/web/src/neo/NeoComposer.tsx';
import type { SessionStore } from '../../../packages/web/src/lib/session-store.ts';
const pending = new URL(location.href).searchParams.has('pending');
const running = new URL(location.href).searchParams.has('running');
const store = {
  sdkMessages: signal([]), agentState: signal({ status: 'idle' }),
  sessionInfo: signal({ config: { model: 'synthetic' }, metadata: pending ? { pendingModelSwitch: { model: 'Sonnet 5.5', provider: 'anthropic', requestedAt: 1 } } : {} }),
  hasMoreMessages: signal(false), error: signal(null), isWorking: signal(pending), refresh: async () => {},
} as unknown as SessionStore;
File.prototype.text = () => new Promise<string>(() => {});
render(<main class="neo-shell p-3"><h1>Synthetic composer auxiliary rows</h1>
  <NeoComposer store={store} sessionId="synthetic-insets" draft="Synthetic draft" onDraft={() => {}}
    onStop={running ? () => {} : undefined}
    onError={() => {}} onTranscript={() => {}} onSend={async () => ({ ok: false, reason: 'Synthetic fixture never sends' })}
    quote={pending ? undefined : { author: 'Neo', text: 'Synthetic quoted summary', anchor: 'synthetic' }}
    previewContext={pending ? undefined : { artifactId: 'bound', snapshot: '00000000', displayName: 'Bound preview', state: 'available' }}
    previewCandidate={pending ? undefined : { artifactId: 'candidate', snapshot: '11111111', displayName: 'New preview', state: 'available' }}
    onRebindPreview={() => {}} />
</main>, document.getElementById('root')!);
