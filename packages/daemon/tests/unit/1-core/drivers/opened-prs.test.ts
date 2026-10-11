import { describe, expect, test } from 'bun:test';
import {
  claudeOpenedPrs,
  codexOpenedPrs,
  keepOpenedPrs,
  WORK_OPENED_PRS_MAX,
} from '../../../../src/lib/drivers/opened-prs.ts';

const pr = (number: number) => `https://github.com/lsm/HyperNeo/pull/${number}`;
const claude = (content: unknown[]) => JSON.stringify({ type: 'assistant', message: { content } });
const use = (id: string, command: string) => claude([{ type: 'tool_use', id, input: { command } }]);
const result = (id: string, content: unknown) =>
  claude([{ type: 'tool_result', tool_use_id: id, content }]);
const codex = (payload: Record<string, unknown>) =>
  JSON.stringify({ type: 'response_item', payload });

describe('claudeOpenedPrs', () => {
  test('takes PR URLs from the output of a gh pr create the session ran, not from other tools', () => {
    expect(
      claudeOpenedPrs([
        use('a', `gh pr create --base dev --body "Follows ${pr(1)}"`),
        result('a', `remote: https://github.com/lsm/HyperNeo/pull/new/x\n${pr(2)}`),
        use('b', 'gh pr view 3'),
        result('b', pr(3)),
        use('c', 'git push && gh pr create --fill'),
        result('c', [{ type: 'text', text: `${pr(4)}\n` }]),
        'not json',
      ])
    ).toEqual([pr(2), pr(4)]);
  });

  test('a transcript that never created a PR has none', () => {
    expect(claudeOpenedPrs([use('a', 'gh pr view 3'), result('a', pr(3))])).toEqual([]);
  });
});

describe('codexOpenedPrs', () => {
  test('takes the output of a gh pr create call and the PRs the thread attached', () => {
    expect(
      codexOpenedPrs([
        codex({ type: 'function_call', call_id: 'c1', arguments: '{"cmd":"gh pr create --fill"}' }),
        codex({ type: 'function_call_output', call_id: 'c1', output: `${pr(5)}\n` }),
        codex({ type: 'function_call', call_id: 'c2', arguments: '{"cmd":"gh pr list"}' }),
        codex({ type: 'function_call_output', call_id: 'c2', output: pr(6) }),
        codex({
          type: 'custom_tool_call',
          call_id: 'c3',
          input: `text(await tools.attach_artifact({artifact_type:"pull_request",url:"${pr(7)}"}));`,
        }),
      ])
    ).toEqual([pr(5), pr(7)]);
  });
});

describe('keepOpenedPrs', () => {
  test('keeps each PR once, at its latest place, and only the newest few', () => {
    expect(keepOpenedPrs([pr(1), pr(2), pr(1).toUpperCase()])).toEqual([
      pr(2),
      pr(1).toUpperCase(),
    ]);
    const many = Array.from({ length: WORK_OPENED_PRS_MAX + 2 }, (_, i) => pr(i));
    expect(keepOpenedPrs(many)).toEqual(many.slice(2));
  });
});
