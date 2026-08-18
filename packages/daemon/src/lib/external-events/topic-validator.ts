export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export function validateGlobPattern(pattern: string): ValidationResult {
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    return { valid: false, reason: 'Topic pattern must not be empty' };
  }

  const segments = pattern.split('/');

  if (segments.length < 2) {
    return {
      valid: false,
      reason:
        `Topic pattern must have at least 2 segments (source/scope); got ${segments.length}. ` +
        `Example: 'github/lsm/neokai/pull_request/5.review_submitted'`,
    };
  }

  for (const segment of segments) {
    if (segment === '') {
      return {
        valid: false,
        reason: 'Topic pattern must not contain empty segments (double slashes)',
      };
    }
    if (segment === '..') {
      return { valid: false, reason: 'Topic pattern must not contain ".." segments' };
    }
    if (segment === '**') {
      return { valid: false, reason: 'Multi-segment "**" wildcard is not supported' };
    }
    if (!/^[a-zA-Z0-9_.*-]+$/.test(segment)) {
      return {
        valid: false,
        reason:
          `Segment "${segment}" contains invalid characters. ` +
          `Use alphanumeric, dash, underscore, dot, or segment-local "*" wildcard.`,
      };
    }
  }

  return { valid: true };
}

export const KNOWN_SOURCES: ReadonlySet<string> = new Set<string>(['github', 'space']);

export function validateLiteralTopic(topic: string): ValidationResult {
  const globCheck = validateGlobPattern(topic);
  if (!globCheck.valid) {
    return globCheck;
  }
  if (topic.includes('*')) {
    return {
      valid: false,
      reason: `Published event topic must be a literal (no wildcards); got "${topic}"`,
    };
  }

  return { valid: true };
}

export function validateSource(source: string): ValidationResult {
  if (typeof source !== 'string' || source.trim().length === 0) {
    return { valid: false, reason: 'Source must be a non-empty string' };
  }
  if (!/^[a-z][a-z0-9_-]*$/.test(source)) {
    return {
      valid: false,
      reason:
        `Source "${source}" must be lowercase, start with a letter, and use only ` +
        `alphanumerics, dashes, and underscores`,
    };
  }
  if (!KNOWN_SOURCES.has(source)) {
    return {
      valid: false,
      reason: `Source "${source}" is not registered. Known sources: ${[...KNOWN_SOURCES].join(', ')}`,
    };
  }
  return { valid: true };
}
