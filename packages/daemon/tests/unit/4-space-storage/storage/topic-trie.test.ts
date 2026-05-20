import { describe, expect, test } from 'bun:test';
import {
	isReceivingStatus,
	segmentMatches,
	TopicTrie,
} from '../../../../src/lib/external-events/topic-trie';

describe('TopicTrie', () => {
	// GitHub 5-segment format: source/owner/repo/resource/entityId.action
	const topic = 'github/lsm/neokai/pull_request/5.review_submitted';

	test('matches an exact topic pattern', () => {
		const trie = new TopicTrie<string>();
		trie.insert('github/lsm/neokai/pull_request/5.review_submitted', 'exact');

		expect(trie.lookup(topic)).toEqual(['exact']);
		expect(trie.lookup('github/lsm/neokai/pull_request/5.opened')).toEqual([]);
	});

	test('matches wildcard owner and repo segments', () => {
		const trie = new TopicTrie<string>();
		trie.insert('github/*/*/pull_request/5.review_submitted', 'wildcard-repo');

		expect(trie.lookup(topic)).toEqual(['wildcard-repo']);
		expect(trie.lookup('github/other/repo/pull_request/5.review_submitted')).toEqual([
			'wildcard-repo',
		]);
	});

	test('matches wildcard action', () => {
		const trie = new TopicTrie<string>();
		trie.insert('github/lsm/neokai/pull_request/5.*', 'wildcard-action');

		expect(trie.lookup(topic)).toEqual(['wildcard-action']);
		expect(trie.lookup('github/lsm/neokai/pull_request/42.review_submitted')).toEqual([]);
	});

	test('matches wildcard action prefix', () => {
		const trie = new TopicTrie<string>();
		trie.insert('github/lsm/neokai/pull_request/5.review_*', 'review-prefix');

		expect(trie.lookup(topic)).toEqual(['review-prefix']);
		expect(trie.lookup('github/lsm/neokai/pull_request/5.comment_created')).toEqual([]);
	});

	test('matches wildcard entity ID', () => {
		const trie = new TopicTrie<string>();
		trie.insert('github/lsm/neokai/pull_request/*.review_submitted', 'any-entity');

		expect(trie.lookup(topic)).toEqual(['any-entity']);
		expect(trie.lookup('github/lsm/neokai/pull_request/42.review_submitted')).toEqual([
			'any-entity',
		]);
		expect(trie.lookup('github/lsm/neokai/issues/5.review_submitted')).toEqual([]);
	});

	test('matches wildcard resource and entity ID', () => {
		const trie = new TopicTrie<string>();
		trie.insert('github/lsm/neokai/*/*.*', 'any-resource-action');

		expect(trie.lookup(topic)).toEqual(['any-resource-action']);
		expect(trie.lookup('github/lsm/neokai/issues/10.opened')).toEqual(['any-resource-action']);
	});

	test('matches fully wildcarded space-level pattern', () => {
		const trie = new TopicTrie<string>();
		trie.insert('github/*/*/*/*.*', 'space-level');

		expect(trie.lookup(topic)).toEqual(['space-level']);
		expect(trie.lookup('github/other/repo/issues/99.opened')).toEqual(['space-level']);
	});

	test('returns all exact and wildcard subscriptions for a matching topic', () => {
		const trie = new TopicTrie<string>();
		trie.insert('github/lsm/neokai/pull_request/5.review_submitted', 'exact');
		trie.insert('github/*/*/pull_request/5.review_submitted', 'wildcard-repo');
		trie.insert('github/lsm/neokai/pull_request/5.*', 'wildcard-action');
		trie.insert('github/lsm/neokai/pull_request/5.review_*', 'review-prefix');
		trie.insert('github/lsm/neokai/pull_request/5.comment_created', 'non-match');

		expect(trie.lookup(topic)).toEqual([
			'exact',
			'wildcard-action',
			'review-prefix',
			'wildcard-repo',
		]);
	});

	test('counts matching values across exact and wildcard branches', () => {
		const trie = new TopicTrie<{ id: string; keep: boolean }>();
		trie.insert('github/lsm/neokai/pull_request/5.review_submitted', {
			id: 'exact',
			keep: true,
		});
		trie.insert('github/*/*/pull_request/5.review_submitted', {
			id: 'wildcard',
			keep: true,
		});
		trie.insert('github/*/*/pull_request/5.closed', { id: 'other', keep: false });

		expect(trie.count((value) => value.keep)).toBe(2);
	});

	test('removes matching values and prunes reusable branches safely', () => {
		const trie = new TopicTrie<{ id: string }>();
		const keep = { id: 'keep' };
		const removeExact = { id: 'remove-exact' };
		const removeWildcard = { id: 'remove-wildcard' };

		trie.insert('github/lsm/neokai/pull_request/5.review_submitted', keep);
		trie.insert('github/lsm/neokai/pull_request/5.review_submitted', removeExact);
		trie.insert('github/*/*/pull_request/5.review_submitted', removeWildcard);

		trie.remove((value) => value.id.startsWith('remove'));

		expect(trie.lookup(topic)).toEqual([keep]);
		expect(trie.lookup('github/other/repo/pull_request/5.review_submitted')).toEqual([]);

		trie.insert('github/*/*/pull_request/5.review_submitted', { id: 'new-wildcard' });
		expect(trie.lookup('github/other/repo/pull_request/5.review_submitted')).toEqual([
			{ id: 'new-wildcard' },
		]);
	});

	test('matches topics case-insensitively', () => {
		const trie = new TopicTrie<string>();
		trie.insert('GitHub/LSM/NeoKai/Pull_Request/5.Review_*', 'mixed-case-pattern');

		expect(trie.lookup(topic)).toEqual(['mixed-case-pattern']);
	});
});

describe('segmentMatches', () => {
	test('matches segment-local wildcard patterns without crossing slashes', () => {
		expect(segmentMatches('5.review_*', '5.review_submitted')).toBe(true);
		expect(segmentMatches('5.*', '5.review_submitted')).toBe(true);
		expect(segmentMatches('*.*', '5.review_submitted')).toBe(true);
		expect(segmentMatches('review_*', 'review_submitted')).toBe(true);
		expect(segmentMatches('review_*', 'review/submitted')).toBe(false);
	});
});

describe('isReceivingStatus', () => {
	test('only excludes cancelled node executions', () => {
		expect(isReceivingStatus('pending')).toBe(true);
		expect(isReceivingStatus('in_progress')).toBe(true);
		expect(isReceivingStatus('idle')).toBe(true);
		expect(isReceivingStatus('waiting_rebind')).toBe(true);
		expect(isReceivingStatus('blocked')).toBe(true);
		expect(isReceivingStatus('cancelled')).toBe(false);
	});
});
