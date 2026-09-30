import '../styles.css';
import '../lib/theme.ts';
import { render } from 'preact';
import { NeoLive } from './NeoLive.tsx';
import { NeoExamples } from './NeoExamples.tsx';
import { useViewportSafety } from '../hooks/useViewportSafety.ts';

function NeoPage() {
  useViewportSafety();
  return new URLSearchParams(location.search).has('examples') ? <NeoExamples /> : <NeoLive />;
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
render(<NeoPage />, root);
