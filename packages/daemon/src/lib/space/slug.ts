const MAX_SLUG_LENGTH = 60;
const DEFAULT_SLUG = 'unnamed-space';

export const RESERVED_SPACE_AGENT_HANDLES = [
  'coordinator',
  'system-runtime',
  'system-workflow',
  'system-messaging',
] as const;

export function slugify(input: string, existingSlugs: string[] = []): string {
  const base = generateBaseSlug(input);
  return resolveCollision(base, existingSlugs);
}

export function slugifyWithinLimit(input: string, existingSlugs: string[] = []): string {
  const base = generateBaseSlug(input);
  return resolveCollisionWithinLimit(base, existingSlugs);
}

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

function generateBaseSlug(input: string): string {
  if (!input || !input.trim()) {
    return DEFAULT_SLUG;
  }

  let slug = input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '-')
    .replace(/[\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  if (!slug) {
    return DEFAULT_SLUG;
  }

  if (slug.length > MAX_SLUG_LENGTH) {
    slug = truncateAtWordBoundary(slug, MAX_SLUG_LENGTH);
  }

  return slug;
}

function truncateAtWordBoundary(slug: string, maxLength: number): string {
  const truncated = slug.slice(0, maxLength);
  const lastHyphen = truncated.lastIndexOf('-');
  if (lastHyphen > 0) {
    return truncated.slice(0, lastHyphen);
  }
  return truncated.replace(/-+$/, '');
}

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

function resolveCollisionWithinLimit(base: string, existingSlugs: string[]): string {
  const slugSet = new Set(existingSlugs);

  if (!slugSet.has(base)) {
    return base;
  }

  let counter = 2;
  while (true) {
    const suffix = `-${counter}`;
    const stem = base.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/, '') || DEFAULT_SLUG;
    const suffixed = `${stem}${suffix}`;
    if (!slugSet.has(suffixed)) {
      return suffixed;
    }
    counter++;
  }
}
