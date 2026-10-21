import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n/index.ts';

export function ArtifactImage({ blob, title }: { blob: Blob; title: string }) {
  const [url, setUrl] = useState<string>();
  const [zoom, setZoom] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const next = URL.createObjectURL(blob);
    setUrl(next);
    setFailed(false);
    return () => {
      URL.revokeObjectURL(next);
    };
  }, [blob]);
  if (failed) return <p role="status">{t('artifact.unsupported')}</p>;
  return (
    <>
      <button
        type="button"
        aria-pressed={zoom}
        class="mb-3 rounded-md bg-surface-raised px-3 py-1 text-sm"
        onClick={() => setZoom(!zoom)}
      >
        {t('artifact.zoom')}
      </button>
      <img
        src={url}
        alt={title}
        class={zoom ? 'max-w-none' : 'max-w-full h-auto'}
        onError={() => setFailed(true)}
      />
    </>
  );
}
