import '../styles.css';
import '../lib/theme.ts';
import { render } from 'preact';
import { ConnectionOverlay } from '../components/ConnectionOverlay.tsx';
import { NeoLive } from './NeoLive.tsx';
import { NeoExamples } from './NeoExamples.tsx';
import { ArtifactPreview } from '../components/artifacts/ArtifactPreview.tsx';
import { useViewportSafety } from '../hooks/useViewportSafety.ts';
import { useNeoLanguageSetting } from './useNeoLanguageSetting.ts';

function NeoPage() {
  useViewportSafety();
  useNeoLanguageSetting();
  const params = new URLSearchParams(location.search);
  if (params.has('examples')) return <NeoExamples />;
  const artifactId = params.get('artifact');
  if (artifactId)
    return (
      <div class="neo-shell h-dvh">
        <ArtifactPreview artifactId={artifactId} onBack={() => location.assign('/neo')} />
      </div>
    );
  return (
    <>
      <ConnectionOverlay />
      <NeoLive />
    </>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
if (new URLSearchParams(location.search).has('examples')) render(<NeoPage />, root);
else
  void fetch('/ws', { credentials: 'same-origin', cache: 'no-store' })
    .then((response) =>
      response.status === 401 ? location.assign('/pair') : render(<NeoPage />, root)
    )
    .catch(() => render(<NeoPage />, root));
