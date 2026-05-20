import { describe, expect, test } from 'bun:test';
import { TopicTrie } from '../../../../src/lib/external-events/topic-trie';

describe('TopicTrie', () => {
	test('matches exact and segment-local wildcard topic patterns', () => {
		const trie = new TopicTrie<string>();
		trie.insert('github/lsm/neokai/pull_request/42.review_submitted', 'exact');
		trie.insert('github/*/*/pull_request/*.*', 'all-pr');
		trie.insert('github/*/*/pull_request/*.review_*', 'reviews');
		trie.insert('slack/*/*/message.*', 'slack');

		expect(trie.lookup('github/lsm/neokai/pull_request/42.review_submitted').sort()).toEqual([
			'all-pr',
			'exact',
			'reviews',
		]);
		expect(trie.lookup('github/lsm/neokai/pull_request/42.comment_created')).toEqual(['all-pr']);
		expect(trie.lookup('slack/team/channel/message.created')).toEqual(['slack']);
	});

	test('removes matching values and prunes empty branches', () => {
		const trie = new TopicTrie<{ runId: string; label: string }>();
		trie.insert('github/*/*/pull_request/*.*', { runId: 'run-1', label: 'first' });
		trie.insert('github/*/*/pull_request/*.*', { runId: 'run-2', label: 'second' });

		trie.remove((value) => value.runId === 'run-1');

		expect(trie.lookup('github/lsm/neokai/pull_request/42.opened')).toEqual([
			{ runId: 'run-2', label: 'second' },
		]);
	});
});
