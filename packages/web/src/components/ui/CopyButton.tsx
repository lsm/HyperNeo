import { CheckGlyph } from '../icons/common-glyphs.tsx';
import { useEffect, useRef, useState } from 'preact/hooks';
import { copyToClipboard } from '../../lib/utils.ts';

interface CopyButtonProps {
  text: string;
  label?: string;
  disabled?: boolean;
  copiedAt?: number;
  showFeedback?: boolean;
  copiedLabel?: string;
  class?: string;
}

export function CopyButton({
  text,
  label = 'Copy to clipboard',
  disabled = false,
  copiedAt,
  showFeedback = false,
  copiedLabel,
  class: className = '',
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (copiedAt) setCopied(true);
  }, [copiedAt]);
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
    if (disabled) return;
    const value = text;
    const success = await copyToClipboard(value);
    if (success && textRef.current === value) {
      setCopied(true);
    }
  };
  const stateClasses = disabled
    ? 'text-fg-muted opacity-50 cursor-not-allowed'
    : copied
      ? 'text-success'
      : 'text-fg-muted hover:text-fg-soft hover:bg-fill-strong';

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={handleCopy}
      title={copied ? (copiedLabel ?? 'Copied!') : label}
      aria-label={showFeedback ? label : undefined}
      class={`copy-button p-1.5 rounded transition-colors ${stateClasses} ${className}`}
    >
      {copied ? (
        <CheckGlyph
          class="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          pathProps={{ strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: 2 }}
        />
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
      {showFeedback && (
        <span aria-live="polite" aria-atomic="true">
          {copied ? (copiedLabel ?? 'Copied') : ''}
        </span>
      )}
    </button>
  );
}
