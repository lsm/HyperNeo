import { useEffect, useRef, useState } from 'preact/hooks';
import { Button } from '../ui/Button.tsx';
import { FormField, formControlClass } from '../ui/FormField.tsx';

type PairState =
  | { kind: 'idle' }
  | { kind: 'pairing' }
  | { kind: 'waiting'; message: string }
  | { kind: 'paired' }
  | { kind: 'failed'; message: string };

function pairFailureMessage(
  status: number,
  body: { error?: unknown; retryAfterMs?: unknown }
): string {
  if (status === 403) return 'Approval was refused. Use an already paired phone or browser.';
  if (status === 401) return 'That code is wrong or expired. Make a new one with hyperneo pair.';
  if (status === 429) {
    const minutes = Math.max(1, Math.ceil(Number(body.retryAfterMs ?? 0) / 60_000));
    return `Too many tries. Pairing reopens in ${minutes} minute${minutes === 1 ? '' : 's'}.`;
  }
  return 'Pairing failed. Check the code and try again.';
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export function PairPage() {
  const [code, setCode] = useState(() => location.hash.slice(1));
  const [name, setName] = useState('Browser');
  const [state, setState] = useState<PairState>({ kind: 'idle' });
  const current = useRef<AbortController | null>(null);
  const busy = state.kind === 'pairing' || state.kind === 'waiting';
  const cancel = () => {
    current.current?.abort();
    setState({ kind: 'idle' });
  };
  useEffect(() => {
    const follow = () => {
      if (location.hash) {
        cancel();
        setCode(location.hash.slice(1));
      }
    };
    addEventListener('hashchange', follow);
    return () => {
      removeEventListener('hashchange', follow);
      current.current?.abort();
    };
  }, []);

  const pair = async (event: Event) => {
    event.preventDefault();
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    const { signal } = controller;
    const until = Date.now() + 10 * 60_000;
    const body = JSON.stringify({ code: code.trim(), name: name.trim() });
    history.replaceState(null, '', location.pathname);
    setState({ kind: 'pairing' });
    const timer = setTimeout(() => {
      controller.abort();
      setState({
        kind: 'failed',
        message: 'Pairing timed out. Make a new code with hyperneo pair.',
      });
    }, until - Date.now());
    try {
      while (!signal.aborted) {
        if (!navigator.onLine || document.visibilityState === 'hidden') {
          setState({
            kind: 'waiting',
            message: 'Pairing paused. Return to this page with a connection to continue.',
          });
          await pause(2000, signal);
          continue;
        }
        const response = await fetch('/pair', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body,
          signal,
        }).catch(() => null);
        if (signal.aborted) return;
        if (response?.ok) {
          setState({ kind: 'paired' });
          return;
        }
        const reply = response ? await response.json().catch(() => ({})) : {};
        if (signal.aborted) return;
        let delay = 2000;
        if (!response)
          setState({
            kind: 'waiting',
            message: 'Waiting for a connection to the daemon. Pairing will retry automatically.',
          });
        else if (response.status === 403 && reply.error === 'awaiting_approval')
          setState({
            kind: 'waiting',
            message:
              'Waiting for Allow on a paired phone or browser. This page will finish pairing automatically.',
          });
        else if (response.status === 429) {
          delay = Number(reply.retryAfterMs ?? 60_000);
          setState({ kind: 'waiting', message: pairFailureMessage(429, reply) });
        } else {
          setState({ kind: 'failed', message: pairFailureMessage(response.status, reply) });
          return;
        }
        await pause(Math.min(delay, until - Date.now()), signal);
      }
    } finally {
      clearTimeout(timer);
    }
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
            <p class="text-xs text-fg-muted">
              If pairing was interrupted after the code was used, check Devices on a paired device
              before making a new code.
            </p>
            <FormField label="Pairing code">
              <input
                class={formControlClass(state.kind === 'failed')}
                value={code}
                disabled={busy}
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
                disabled={busy}
                maxLength={80}
                onInput={(event) => setName(event.currentTarget.value)}
              />
            </FormField>
            {state.kind === 'failed' && <p class="text-sm text-danger">{state.message}</p>}
            {state.kind === 'waiting' && (
              <p role="status" class="text-sm text-fg-muted">
                {state.message}
              </p>
            )}
            <Button type="submit" fullWidth disabled={busy || !code.trim() || !name.trim()}>
              Pair this browser
            </Button>
            {busy && (
              <Button fullWidth variant="secondary" onClick={cancel}>
                Stop waiting
              </Button>
            )}
          </form>
        )}
      </div>
    </main>
  );
}
