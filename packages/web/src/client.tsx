import './styles.css';
import './lib/theme.ts';
import { render } from 'preact';
import { App } from './App.tsx';
import { PairPage } from './components/pairing/PairPage.tsx';
import { spaceWebExtension } from './lib/space-web-extension.ts';
import { registerWebExtension } from './lib/web-extensions.ts';

registerWebExtension('space', spaceWebExtension);

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
