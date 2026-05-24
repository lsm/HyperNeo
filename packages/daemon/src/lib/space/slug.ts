/**
 * Slug Utilities
 *
 * Shared slugify utility for generating URL-safe, human-readable identifiers.
 * Used for space slugs and any future slug needs (e.g., worktree naming).
 *
 * Rules:
 * - Lowercase
 * - Replace spaces and non-alphanumeric characters with hyphens
 * - Collapse consecutive hyphens
 * - Strip leading/trailing hyphens
 * - Truncate to max 60 chars at word boundary
 * - Collision suffix (-2, -3, etc.)
 * - Empty input falls back to 'unnamed-space'
 */

const MAX_SLUG_LENGTH = 60;
const DEFAULT_SLUG = 'unnamed-space';

/**
 * Generate a URL-safe slug from an input string.
 * If the generated slug collides with existing slugs, appends a numeric suffix (-2, -3, ...).
 *
 * @param input - The string to slugify (typically a space name)
 * @param existingSlugs - Array of slugs already in use, for collision avoidance
 * @returns A unique, URL-safe slug
 */
export function slugify(input: string, existingSlugs: string[] = []): string {
  const base = generateBaseSlug(input);
  return resolveCollision(base, existingSlugs);
}

/**
 * Validate that a slug meets format requirements.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateSlug(slug: string): string | null {
  if (!slug) {
    return 'Slug cannot be empty';
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    return `Slug must be ${MAX_SLUG_LENGTH} characters or fewer`;
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(slug)) {
    return 'Slug must contain only lowercase letters, numbers, and hyphens, and must start and end with a letter or number';
  }
  if (/--/.test(slug)) {
    return 'Slug must not contain consecutive hyphens';
  }
  return null;
}

/**
 * Generate the base slug from input without collision resolution.
 */
function generateBaseSlug(input: string): string {
  if (!input || !input.trim()) {
    return DEFAULT_SLUG;
  }

  let slug = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '-') // Replace non-alphanumeric (except spaces/hyphens) with hyphens
    .replace(/[\s]+/g, '-') // Replace spaces with hyphens
    .replace(/-{2,}/g, '-') // Collapse consecutive hyphens
    .replace(/^-+/, '') // Strip leading hyphens
    .replace(/-+$/, ''); // Strip trailing hyphens

  if (!slug) {
    return DEFAULT_SLUG;
  }

  // Truncate at word boundary (hyphen) if exceeding max length
  if (slug.length > MAX_SLUG_LENGTH) {
    slug = truncateAtWordBoundary(slug, MAX_SLUG_LENGTH);
  }

  return slug;
}

/**
 * Truncate a slug at a word boundary (hyphen) to fit within maxLength.
 * Falls back to hard truncation if no hyphen found.
 */
function truncateAtWordBoundary(slug: string, maxLength: number): string {
  const truncated = slug.slice(0, maxLength);
  // Find the last hyphen within the truncated string
  const lastHyphen = truncated.lastIndexOf('-');
  if (lastHyphen > 0) {
    return truncated.slice(0, lastHyphen);
  }
  // No hyphen found — hard truncate and strip trailing hyphens
  return truncated.replace(/-+$/, '');
}

/**
 * Resolve slug collisions by appending a numeric suffix (-2, -3, ...).
 */
export function resolveCollision(base: string, existingSlugs: string[]): string {
  const slugSet = new Set(existingSlugs);

  if (!slugSet.has(base)) {
    return base;
  }

  let counter = 2;
  while (true) {
    const suffixed = `${base}-${counter}`;
    if (!slugSet.has(suffixed)) {
      return suffixed;
    }
    counter++;
  }
}
