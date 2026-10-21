import { useEffect, useState } from 'preact/hooks';
import { Button } from '../ui/Button.tsx';
import { FormField, formControlClass } from '../ui/FormField.tsx';

type PairState =
  | { kind: 'idle' }
  | { kind: 'pairing' }
  | { kind: 'paired' }
  | { kind: 'failed'; message: string };

function pairFailureMessage(
  status: number,
  body: { error?: unknown; retryAfterMs?: unknown }
): string {
  if (status === 403)
    return 'This code needs Allow first. Tap Allow on your paired phone, then pair again.';
  if (status === 401) return 'That code is wrong or expired. Make a new one with hyperneo pair.';
  if (status === 429) {
    const minutes = Math.max(1, Math.ceil(Number(body.retryAfterMs ?? 0) / 60_000));
    return `Too many tries. Pairing reopens in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }
  return 'Pairing failed. Check the code and try again.';
}

export function PairPage() {
  const [code, setCode] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const follow = () => {
      if (location.hash) setCode(location.hash.slice(1));
    };
    addEventListener('hashchange', follow);
    return () => removeEventListener('hashchange', follow);
  }, []);
  const [name, setName] = useState('Browser');
  const [state, setState] = useState<PairState>({ kind: 'idle' });

  const pair = async (event: Event) => {
    event.preventDefault();
    setState({ kind: 'pairing' });
    const response = await fetch('/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim(), name: name.trim() }),
    }).catch(() => null);
    if (response?.ok) {
      history.replaceState(null, '', location.pathname);
      setState({ kind: 'paired' });
      return;
    }
    const body = response ? await response.json().catch(() => ({})) : {};
    setState({ kind: 'failed', message: pairFailureMessage(response?.status ?? 0, body) });
  };

  return (
    <main class="flex min-h-screen items-center justify-center bg-bg px-4 text-fg">
      <div class="w-full max-w-sm rounded-lg border border-line bg-surface p-6">
        <h1 class="mb-1 text-lg font-semibold">Pair this browser</h1>
        {state.kind === 'paired' ? (
          <div class="space-y-4">
            <p class="text-sm text-fg-muted">This browser is paired.</p>
            <a class="text-sm font-medium text-accent hover:underline" href="/">
              Open HyperNeo
            </a>
          </div>
        ) : (
          <form class="space-y-4" onSubmit={pair}>
            <p class="text-sm text-fg-muted">
              Enter the code from hyperneo pair or from a paired device.
            </p>
            <FormField label="Pairing code">
              <input
                class={formControlClass(state.kind === 'failed')}
                value={code}
                autocomplete="off"
                autocapitalize="characters"
                spellcheck={false}
                onInput={(event) => setCode(event.currentTarget.value)}
              />
            </FormField>
            <FormField label="Name for this browser">
              <input
                class={formControlClass()}
                value={name}
                maxLength={80}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </FormField>
            {state.kind === 'failed' && <p class="text-sm text-danger">{state.message}</p>}
            <Button
              type="submit"
              fullWidth
              disabled={state.kind === 'pairing' || !code.trim() || !name.trim()}
            >
              Pair this browser
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
