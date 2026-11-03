import './styles.css';
import './lib/theme.ts';
import { render } from 'preact';
import { App } from './App.tsx';
import { PairPage } from './components/pairing/PairPage.tsx';
import { connectionManager } from './lib/connection-manager.ts';
import { loadWebExtensions } from './lib/web-extensions.ts';

void loadWebExtensions(() => connectionManager.getHub(), {
  space: () => import('./lib/space-web-extension.ts').then((m) => m.spaceWebExtension),
});

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

function renderApp() {
  if (location.pathname === '/pair') return render(<PairPage />, root!);
  void fetch('/ws', { credentials: 'same-origin', cache: 'no-store' })
    .then((response) => render(response.status === 401 ? <PairPage /> : <App />, root!))
    .catch(() => render(<App />, root!));
}

renderApp();

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    renderApp();
  });
}
