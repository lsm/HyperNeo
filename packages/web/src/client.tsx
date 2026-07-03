import './styles.css';
import { render } from 'preact';
import { App } from './App.tsx';

// The chat/task-thread scroll containers manage their own scroll-to-bottom on
// mount (see `useAutoScroll`). Opt out of the browser's automatic
// scroll-position restoration so a refresh while on a long thread doesn't
// clobber the just-restored bottom position. This is a defense-in-depth
// complement to `useAutoScroll`'s bounded settle-scroll — not relied on alone,
// since late content/layout growth is also part of the refresh race.
if ('scrollRestoration' in history) {
  history.scrollRestoration = 'manual';
}

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

// Render the app
function renderApp() {
  render(<App />, root!);
}

// Initial render
renderApp();

// Hot Module Replacement (HMR) support
if (import.meta.hot) {
  import.meta.hot.accept(() => {
    renderApp();
  });
}
