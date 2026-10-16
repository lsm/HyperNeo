import { useEffect, useState } from 'preact/hooks';

export function NeoBusyRow({ words }: { words: readonly string[] }) {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    setIndex(0);
    if (words.length < 2) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      setIndex((previous) => previous + 1);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [words]);
  return (
    <div role="status" class="neo-progress" aria-live="polite">
      <span class="neo-progress-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>{words[index % words.length]}</span>
    </div>
  );
}
