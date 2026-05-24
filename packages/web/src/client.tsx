import './styles.css';
import { render } from 'preact';
import { App } from './App.tsx';

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
