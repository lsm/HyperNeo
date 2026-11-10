import { useEffect, useRef, useState } from 'preact/hooks';
import { t } from '../../lib/i18n/index.ts';

export function ArtifactVideo({ blob, title }: { blob: Blob; title: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [source, setSource] = useState<{ blob: Blob; url: string }>();
  const [failed, setFailed] = useState<string>();
  const url = source?.blob === blob ? source.url : undefined;
  useEffect(() => {
    const next = URL.createObjectURL(blob);
    const element = video.current;
    setSource({ blob, url: next });
    return () => {
      element?.pause();
      element?.removeAttribute('src');
      element?.load();
      URL.revokeObjectURL(next);
    };
  }, [blob]);
  return url && failed === url ? (
    <p role="status" class="text-sm text-fg-muted">
      {t('artifact.videoError')}
    </p>
  ) : (
    <video
      ref={video}
      src={url}
      aria-label={title}
      controls
      playsInline
      preload="metadata"
      class="max-h-full w-full rounded-md object-contain"
      onError={() => setFailed(url)}
    />
  );
}
