import './styles.css';
import { render } from 'preact';
import { App } from './App.tsx';

if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

function renderApp() {
  render(<App />, root!);
}

renderApp();

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    renderApp();
  });
}
