/**
 * Topic validation for external-event topics and subscription glob patterns.
 *
 * Topic shape is source-specific. GitHub currently uses
 * `github/owner/repo/resource.action` (4 segments); other sources may use
 * different depths. Each source extension defines and enforces its own schema.
 *
 * `validateGlobPattern()` enforces only the universal structural constraints
 * shared by all sources: non-empty, no empty segments, no `..`, no `**`,
 * valid characters per segment. Source-specific depth and structure checks
 * belong in the extension.
 *
 * The subscription glob pattern uses the same shape; segments may be the
 * single-segment wildcard star, dotted-segment wildcard suffixes, or a literal value.
 *
 * `validateGlobPattern()` is the single source of truth for both topic literals
 * (called when an extension publishes) and subscription patterns (called when a
 * workflow declares an `eventInterest`). It is intentionally strict about
 * structural safety — patterns that pass validation must never silently fail to
 * match a well-formed topic.
 */

export interface ValidationResult {
	valid: boolean;
	reason?: string;
}

/**
 * Validate a topic literal or subscription glob pattern.
 *
 * Universal constraints:
 * - Non-empty.
 * - At least 2 slash-delimited segments (source + one scope segment).
 * - No empty segments (`a//b`).
 * - No `..` segments.
 * - No multi-segment `**` wildcard (not supported).
 * - Each segment uses only `[a-zA-Z0-9_.*-]`.
 *
 * Note: glob star is allowed only as a whole-segment wildcard or as part of a
 * dotted segment. It is not treated as a regex metacharacter — segment matching
 * is done by the trie.
 */
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
				`Example: 'github/lsm/neokai/pull_request.review_submitted'`,
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

/**
 * Allow-list of source identifiers known to the daemon. Extensions register
 * their identifier here so unknown/typo'd sources fail loudly at publish time
 * rather than silently storing topics that no subscriber will ever match.
 */
export const KNOWN_SOURCES: ReadonlySet<string> = new Set<string>(['github']);

/**
 * Validate that a topic is a literal (no wildcards) suitable for storing
 * as a published external event.
 *
 * This is stricter than `validateGlobPattern` — it rejects any `*` characters
 * since published events must be concrete topics, not subscription patterns.
 *
 * Source-specific validation (segment count, format rules) is the responsibility
 * of each extension. This function only enforces universal structural constraints.
 */
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
