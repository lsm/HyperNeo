import './styles.css';
import './lib/theme.ts';
import { render } from 'preact';
import { App } from './App.tsx';
import { PairPage } from './components/pairing/PairPage.tsx';
import { connectionManager } from './lib/connection-manager.ts';
import { loadWebExtensions } from './lib/web-extensions.ts';

void connectionManager
  .getHub()
  .then((hub) =>
    loadWebExtensions(hub, {
      space: () => import('./lib/space-web-extension.ts').then((m) => m.spaceWebExtension),
    })
  )
  .catch(() => {});

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

function renderApp() {
  render(location.pathname === '/pair' ? <PairPage /> : <App />, root!);
}

renderApp();

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    renderApp();
  });
}
