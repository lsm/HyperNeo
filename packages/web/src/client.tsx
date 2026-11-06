import './styles.css';
import './lib/theme.ts';
import { render } from 'preact';
import { App } from './App.tsx';
import { PairPage } from './components/pairing/PairPage.tsx';
import { connectionManager } from './lib/connection-manager.ts';
import { commandRegistry } from './lib/command-registry.ts';
import { SPACE_COMMANDS } from './lib/space-commands.ts';
import { registerRouteExtension } from './lib/router.ts';
import { spaceNav } from './components/space/space-nav.tsx';
import { spaceRoutes } from './lib/space-router.ts';
import { declareExtensionNav, loadWebExtensions } from './lib/web-extensions.ts';

declareExtensionNav(spaceNav);
registerRouteExtension(spaceRoutes);
commandRegistry.registerAll(SPACE_COMMANDS);

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
