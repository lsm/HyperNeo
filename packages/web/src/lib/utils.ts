import { clsx, type ClassValue } from 'clsx';

/**
 * Utility function to merge class names
 */
export function cn(...inputs: ClassValue[]) {
  return clsx(inputs);
}

/**
 * Copy text to clipboard
 *
 * Uses modern Clipboard API when available (requires secure context: HTTPS or localhost).
 * Falls back to legacy execCommand('copy') for insecure contexts (e.g., HTTP on LAN IP).
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Try modern Clipboard API first (requires secure context)
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to legacy method
    }
  }

  // Fallback: legacy execCommand('copy') for insecure contexts
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    // Avoid scrolling to bottom
    textarea.style.position = 'fixed';
    textarea.style.top = '0';
    textarea.style.left = '0';
    textarea.style.width = '2em';
    textarea.style.height = '2em';
    textarea.style.padding = '0';
    textarea.style.border = 'none';
    textarea.style.outline = 'none';
    textarea.style.boxShadow = 'none';
    textarea.style.background = 'transparent';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    const successful = document.execCommand('copy');
    document.body.removeChild(textarea);

    return successful;
  } catch {
    return false;
  }
}

/**
 * Format relative time
 */
export function formatRelativeTime(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (seconds < 60) {
    return 'Just now';
  } else if (minutes < 60) {
    return `${minutes}m ago`;
  } else if (hours < 24) {
    return `${hours}h ago`;
  } else if (days === 1) {
    return 'Yesterday';
  } else if (days < 7) {
    return `${days}d ago`;
  } else {
    return date.toLocaleDateString();
  }
}

/**
 * Format relative time from a timestamp (ms since epoch)
 */
export function getRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Format a relative time that may be in the past OR the future.
 *
 * Used by the Scheduled tab's `nextRunAt` column where timestamps are normally
 * future-dated but may briefly land in the past (clock drift, schedule fired
 * but not yet advanced, etc.). `getRelativeTime` is past-only and would render
 * future timestamps as "just now", which is misleading.
 */
export function formatRelativeFuture(ts: number): string {
  const diff = ts - Date.now();
  const future = diff >= 0;
  const abs = Math.abs(diff);
  const minutes = Math.floor(abs / 60_000);
  if (minutes < 1) return future ? 'in <1m' : 'just now';
  if (minutes < 60) return future ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return future ? `in ${hours}h` : `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return future ? `in ${days}d` : `${days}d ago`;
}

/**
 * Format token count in k format (e.g., 16500 -> "16.5k")
 */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return tokens.toString();
  }
  const k = tokens / 1000;
  // Show 1 decimal place for precision
  return `${k.toFixed(1)}k`;
}
