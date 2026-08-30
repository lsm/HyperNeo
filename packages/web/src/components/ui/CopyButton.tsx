import { useEffect, useRef, useState } from 'preact/hooks';
import { copyToClipboard } from '../../lib/utils.ts';

interface CopyButtonProps {
  text: string;
  label?: string;
}

export function CopyButton({ text, label = 'Copy to clipboard' }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const textRef = useRef(text);
  textRef.current = text;

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const prevTextRef = useRef(text);
  useEffect(() => {
    if (prevTextRef.current === text) return;
    prevTextRef.current = text;
    setCopied(false);
  }, [text]);

  const handleCopy = async () => {
    const value = text;
    const success = await copyToClipboard(value);
    if (success && textRef.current === value) {
      setCopied(true);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={copied ? 'Copied!' : label}
      class={`p-1.5 rounded transition-colors ${
        copied ? 'text-success' : 'text-fg-muted hover:text-fg-soft hover:bg-fill-strong'
      }`}
    >
      {copied ? (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
          />
        </svg>
      )}
    </button>
  );
}
