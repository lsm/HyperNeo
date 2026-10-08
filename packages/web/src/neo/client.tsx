import '../styles.css';
import '../lib/theme.ts';
import { render } from 'preact';
import { ConnectionOverlay } from '../components/ConnectionOverlay.tsx';
import { NeoLive } from './NeoLive.tsx';
import { NeoExamples } from './NeoExamples.tsx';
import { useViewportSafety } from '../hooks/useViewportSafety.ts';

function NeoPage() {
  useViewportSafety();
  if (new URLSearchParams(location.search).has('examples')) return <NeoExamples />;
  return (
    <>
      <ConnectionOverlay />
      <NeoLive />
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
render(<NeoPage />, root);
