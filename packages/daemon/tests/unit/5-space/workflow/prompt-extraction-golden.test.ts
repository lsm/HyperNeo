import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  CALL_ACTION_PREFERENCE_GUIDANCE,
  POST_APPROVAL_COMPLETION_INSTRUCTIONS,
} from '@hyperneo/prompts';
import { coderAgent } from '../../../../src/lib/agent/coordinator/coder.ts';
import { COORDINATOR_AGENT } from '../../../../src/lib/agent/coordinator/coordinator.ts';
import { debuggerAgent } from '../../../../src/lib/agent/coordinator/debugger.ts';
import { reviewerAgent } from '../../../../src/lib/agent/coordinator/reviewer.ts';
import { testerAgent } from '../../../../src/lib/agent/coordinator/tester.ts';
import { vcsAgent } from '../../../../src/lib/agent/coordinator/vcs.ts';
import { verifierAgent } from '../../../../src/lib/agent/coordinator/verifier.ts';
import { SECURITY_AGENT_SYSTEM_PROMPT } from '../../../../src/lib/github/prompts/security-prompt.ts';
import { buildTitleGenerationPrompt } from '../../../../src/lib/session/session-lifecycle.ts';
import { NON_DELEGATING_GENERAL_AGENT } from '../../../../src/lib/space/agents/custom-agent.ts';
import { LONG_HORIZON_SCHEDULING_GUARDRAIL } from '../../../../src/lib/space/agents/long-horizon-agent-tools.ts';
import {
  getPresetAgentTemplates,
  LEGACY_REVIEWER_PROMPT,
} from '../../../../src/lib/space/agents/seed-agents.ts';
import {
  QA_SYSTEM_CONTRACT,
  REVIEWER_SYSTEM_CONTRACT,
} from '../../../../src/lib/space/agents/system-contracts.ts';
import { buildSelectionPrompt } from '../../../../src/lib/space/runtime/llm-workflow-selector.ts';
import { appendPostApprovalCompletionInstructions } from '../../../../src/lib/space/runtime/post-approval-router.ts';
import { buildPromptTooLongContinueNag } from '../../../../src/lib/session/prompt-too-long-recovery.ts';
import {
  CODER_EXTERNAL_GATE_BLOCK,
  CODER_ONLY_MERGE_INSTRUCTIONS,
  CODER_ONLY_PROMPT,
  CODER_OWNED_MERGE_PROMPT,
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE,
  CODER_OWNED_QA_PROMPT,
  CODER_OWNED_QA_REVIEW_PROMPT,
  CODER_OWNED_REVIEW_PROMPT,
  CODEX_REACTION_APPROVAL_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE,
  FULLSTACK_CODING_NOCHANGE_GUIDANCE,
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH,
  RESEARCH_PROMPT,
  RESEARCH_REVIEW_PROMPT,
  REVIEW_ONLY_REVIEW_PROMPT,
  REVIEW_POLICY_GUIDANCE,
  REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE,
  REVIEW_THREAD_RESOLUTION_GUIDANCE,
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH,
  REVIEWER_ZERO_FINDINGS_GATE,
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';

const GOLDEN: Record<string, string> = {
  CODEX_REACTION_APPROVAL_GUIDANCE:
    '2e1dbf1a39b2c9b47dc930c2614e3d85c93d0ea2175d3149162262725a4966be',
  CODER_EXTERNAL_GATE_BLOCK: 'e4020f4406f182b4edd57a74bd17d1f7f3b7efeec017f7b1f5dd83d2790d720d',
  CODER_ONLY_MERGE_INSTRUCTIONS: '5543ba55a4fe4b68a80832481cd4a561f0990e308f979c5be7adb3a5dc85491e',
  CODER_ONLY_PROMPT: '142b07ce7a51bca8401de280efa0ea32da3918111801ed4873a9e33a9e1f7ada',
  CODER_OWNED_MERGE_INSTRUCTIONS:
    '04a47ad5a22134e679233bd4038a9037bbb9aa0fc3ec8166e3172a68829d4d01',
  CODER_OWNED_MERGE_PROMPT: '2019d2456bb199c58b14e0fefd9553e3fc24c878a9010979f1b56d933ac7797e',
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE:
    '849ec685a272e0a751689014bd717b5e2103ccfb02d6b5b18e90eaad86bbb6e1',
  CODER_OWNED_QA_PROMPT: '6ad1afe0c7e099fa117f2c95ebc6be45a7c7edcb46aed98876d93058119adff1',
  CODER_OWNED_QA_REVIEW_PROMPT: '1e7e69cf223816813c015fd80b82240688b092559485bb48eccb14f75c16fe1f',
  CODER_OWNED_REVIEW_PROMPT: '467779a984795c4b3b9f037f3233624c1b18010fd4b2fd188f71c7f6a42cf0b4',
  EXTERNAL_REVIEW_BOTS_GUIDANCE: '5cd7f3fe6b9a05536d0544461e1439fa01691ab4a6e821696975ac418af87933',
  FULLSTACK_CODING_NOCHANGE_GUIDANCE:
    '74f56a17289baccf098c526fe6397b8894414f6cd3fd8178af86f5e3a16b95a4',
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH:
    '77d86b527ae489e9b32394ddbe2ee72f1ac5b283fe065902e72485ce9fb62030',
  RESEARCH_PROMPT: '913955fda9e3844e52331e17f8f14c08214dfde770beff924c183d3b0eba660c',
  RESEARCH_REVIEW_PROMPT: '95074abf105e87fa6a3752e7d16097fc46663c5a28fb5f7e3ff682c582d37269',
  REVIEW_ONLY_REVIEW_PROMPT: '9cb98891db684bab99494d69ddeb86c5dff04edf1e0306e6cb5cc9239f1df289',
  CALL_ACTION_PREFERENCE_GUIDANCE:
    '7c92b6970e05806e33f7c8e5b6761cb0466dc3129343dd6cf1bbbef05bd6f249',
  REVIEW_POLICY_GUIDANCE: '6ba821ea3dd2c230a4bd44cf70f17f24bcecf0741e99f68978a689c7904fddf7',
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH:
    'a86da78d4d26ac27bf38510364b449a905abc3421297fffd180f62ee1c585c60',
  REVIEWER_ZERO_FINDINGS_GATE: '6c8ce493c0f210efa5687cefb6494fb7f6a2261731f57ef32c60183f68fc4bce',
  REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE:
    '1815eaf2b9369f95d8a5742891ef38ba2fdcf50de8f8f18234831febb70b65d0',
  REVIEW_THREAD_RESOLUTION_GUIDANCE:
    '48b32262a1df32c43b4f87933592e1e222c8c7f6b731dac27eede79b61c14ee9',
  LEGACY_REVIEWER_PROMPT: '3d62ec5b500028f9513df1c9d4cd6dad24a8e956026a12969fc59c7117c76d8d',
  LONG_HORIZON_SCHEDULING_GUARDRAIL:
    'ac04d03c6c3b4c72db7af0179d6fa06b68b12bcdcd0b71e91e73500fbb3658c5',
  NON_DELEGATING_GENERAL_PROMPT: '5543aeae7a2a3aac9c5a4f9b489e3849c0998cb5e1d82b20e383da876fc5ae89',
  PRESET_CODER_PROMPT: '57b0ef8003e8e0ddea9aa4bb44404e1a8367fe43991c421046ca348d96fb1911',
  PRESET_RESEARCH_PROMPT: 'acc05ba0296ae52784b5477f97bd7246446644510c8e8228540f6387bcd8495e',
  QA_SYSTEM_CONTRACT: '60ea7a78cff979f2bcd8269108da1c47e67d411d170ca071407c81b270f41d51',
  REVIEWER_SYSTEM_CONTRACT: '072afa429bae40ca8cccd739e808000c8094160ab5b0d169c9379d39d9c87854',
  COORDINATOR_PROMPT: '28f30cf29ed5764a703a90029dc468c5e905dc8eb057abf1779e3e5ce9e25487',
  GITHUB_SECURITY_SYSTEM_PROMPT: '486aff88bf9a9c66ac69abe074270c5c538a1433c81dc126228f97de5f65c9bd',
  SUBAGENT_CODER_PROMPT: '5f01cfb2266c6f8a2d154da7aea4162e2297236545bcad2248447a974d6a1dac',
  SUBAGENT_DEBUGGER_PROMPT: '844cd806780d789b9d24466d7157be365e87a55064fa1108681ec7510b12aed1',
  SUBAGENT_REVIEWER_PROMPT: '3d62ec5b500028f9513df1c9d4cd6dad24a8e956026a12969fc59c7117c76d8d',
  SUBAGENT_TESTER_PROMPT: '9197c4c373bd99d8b3fb88dd7ed98788cd30521ca710c8adc8be139983a40bad',
  SUBAGENT_VCS_PROMPT: 'ea28eae3d3fb3291df5324077b0f7d602ff9abe8222ffb2eec71c69fedbdb2b1',
  SUBAGENT_VERIFIER_PROMPT: 'b5c24ec4a2b90c6ddc5b851e33e14da2fad554c528fa93027a9bc5a08dbfbfe0',
  POST_APPROVAL_COMPLETION_INSTRUCTIONS:
    '99579e535f19b51ec01d42f2014982ff2a2ea309bfc92f5251b1fdfcc70cc640',
  PROMPT_TOO_LONG_CONTINUE_NAG: '6087c6a95dc3d926b9c7e683ea1f125dc8fd26052b6291c93fab1d0512f79005',
  TITLE_GENERATION_PROMPT: '90eb78808852b1639e84818f8447dcb02a2b3f9e2e1fb664edf54c930c3610dd',
  WORKFLOW_SELECTOR_INSTRUCTIONS:
    'edacda28ae7fb8b7eb43631c3324b3fa8e01a82ea096313fcb7057bede914d83',
};

const byPreset = new Map(getPresetAgentTemplates().map((p) => [p.handle, p.customPrompt]));
const VALUES: Record<string, string> = {
  WORKFLOW_SELECTOR_INSTRUCTIONS: (() => {
    const full = buildSelectionPrompt(
      { title: 't', description: 'd' } as never,
      [{ id: 'x', name: 'n', description: 'e', tags: [] }] as never
    );
    const marker = 'Instructions:\n';
    return full.slice(full.lastIndexOf(marker) + marker.length);
  })(),
  CODEX_REACTION_APPROVAL_GUIDANCE,
  CODER_ONLY_MERGE_INSTRUCTIONS,
  CODER_ONLY_PROMPT,
  CODER_OWNED_MERGE_PROMPT,
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE,
  CODER_OWNED_QA_PROMPT,
  CODER_OWNED_QA_REVIEW_PROMPT,
  CODER_OWNED_REVIEW_PROMPT,
  FULLSTACK_CODING_NOCHANGE_GUIDANCE,
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH,
  RESEARCH_PROMPT,
  RESEARCH_REVIEW_PROMPT,
  REVIEW_ONLY_REVIEW_PROMPT,
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH,
  REVIEWER_ZERO_FINDINGS_GATE,
  REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE,
  REVIEW_THREAD_RESOLUTION_GUIDANCE,
  CODER_EXTERNAL_GATE_BLOCK,
  EXTERNAL_REVIEW_BOTS_GUIDANCE,
  REVIEW_POLICY_GUIDANCE,
  CALL_ACTION_PREFERENCE_GUIDANCE,
  CODER_OWNED_MERGE_INSTRUCTIONS,
  QA_SYSTEM_CONTRACT,
  REVIEWER_SYSTEM_CONTRACT,
  LEGACY_REVIEWER_PROMPT,
  LONG_HORIZON_SCHEDULING_GUARDRAIL,
  NON_DELEGATING_GENERAL_PROMPT: NON_DELEGATING_GENERAL_AGENT.prompt,
  PRESET_CODER_PROMPT: byPreset.get('swe')!,
  PRESET_RESEARCH_PROMPT: byPreset.get('research')!,
  COORDINATOR_PROMPT: COORDINATOR_AGENT.prompt,
  SUBAGENT_CODER_PROMPT: coderAgent.prompt,
  SUBAGENT_REVIEWER_PROMPT: reviewerAgent.prompt,
  SUBAGENT_DEBUGGER_PROMPT: debuggerAgent.prompt,
  SUBAGENT_TESTER_PROMPT: testerAgent.prompt,
  SUBAGENT_VCS_PROMPT: vcsAgent.prompt,
  SUBAGENT_VERIFIER_PROMPT: verifierAgent.prompt,
  POST_APPROVAL_COMPLETION_INSTRUCTIONS,
  PROMPT_TOO_LONG_CONTINUE_NAG: buildPromptTooLongContinueNag(),
  TITLE_GENERATION_PROMPT: buildTitleGenerationPrompt('').slice(0, -1),
  GITHUB_SECURITY_SYSTEM_PROMPT: SECURITY_AGENT_SYSTEM_PROMPT,
};

describe('prompt extraction golden hashes', () => {
  test('every extracted prompt is byte-identical to its pre-extraction value', () => {
    expect(Object.keys(VALUES).sort()).toEqual(Object.keys(GOLDEN).sort());
    for (const [id, expected] of Object.entries(GOLDEN)) {
      if (VALUES[id] === undefined) {
        throw new Error(`undefined value for id: ${id}`);
      }
      const actual = createHash('sha256').update(VALUES[id]!).digest('hex');
      expect(actual, id).toBe(expected);
    }
  });
});

describe('workflow prompts prefer the operations door with named-operation fallback', () => {
  const OPERATION_DOOR_PROMPTS: Record<string, string> = {
    CODER_ONLY_PROMPT,
    CODER_OWNED_MERGE_PROMPT,
    CODER_OWNED_REVIEW_PROMPT,
    CODER_OWNED_QA_PROMPT,
    CODER_OWNED_QA_REVIEW_PROMPT,
    RESEARCH_PROMPT,
    RESEARCH_REVIEW_PROMPT,
    REVIEW_ONLY_REVIEW_PROMPT,
    CODER_ONLY_MERGE_INSTRUCTIONS,
    CODER_OWNED_MERGE_INSTRUCTIONS,
  };

  test('every workflow role prompt and merge instruction carries the operations-door prose', () => {
    for (const [id, text] of Object.entries(OPERATION_DOOR_PROMPTS)) {
      expect(text, id).toContain('use `invoke(name, input)`');
      expect(text, id).toContain('invoke(name="operations.list")');
    }
  });

  test('the preference prose enumerates only typed tool names the prompts already use', () => {
    for (const name of [
      'save_artifact',
      'send_message',
      'subscribe_pr_events',
      'approve_task',
      'submit_for_approval',
      'mark_complete',
    ]) {
      expect(CALL_ACTION_PREFERENCE_GUIDANCE).toContain(`\`${name}\``);
      const usedBy = Object.entries(OPERATION_DOOR_PROMPTS).filter(([, text]) =>
        text.replace(CALL_ACTION_PREFERENCE_GUIDANCE, '').includes(name)
      );
      expect(usedBy.length, name).toBeGreaterThan(0);
    }
  });
});

describe('builder-internal prompt seams', () => {
  test('title, selector, nag, and completion instructions compose their extracted values', () => {
    const titleOut = buildTitleGenerationPrompt('FIXTURE_MSG');
    expect(titleOut.startsWith('Based on the user')).toBe(true);
    expect(titleOut.endsWith('FIXTURE_MSG')).toBe(true);
    expect(
      createHash('sha256')
        .update(titleOut.slice(0, titleOut.length - 'FIXTURE_MSG'.length - 1))
        .digest('hex')
    ).toBe(GOLDEN.TITLE_GENERATION_PROMPT);

    const selectorOut = buildSelectionPrompt(
      { title: 't', description: 'd' } as never,
      [{ id: 'x', name: 'n', description: 'e', tags: [] }] as never
    );
    const marker = 'Instructions:\n';
    const selectorValue = selectorOut.slice(selectorOut.lastIndexOf(marker) + marker.length);
    expect(createHash('sha256').update(selectorValue).digest('hex')).toBe(
      GOLDEN.WORKFLOW_SELECTOR_INSTRUCTIONS
    );

    expect(createHash('sha256').update(buildPromptTooLongContinueNag()).digest('hex')).toBe(
      GOLDEN.PROMPT_TOO_LONG_CONTINUE_NAG
    );

    expect(createHash('sha256').update(POST_APPROVAL_COMPLETION_INSTRUCTIONS).digest('hex')).toBe(
      GOLDEN.POST_APPROVAL_COMPLETION_INSTRUCTIONS
    );
    expect(appendPostApprovalCompletionInstructions('')).toBe(
      `\n\n${POST_APPROVAL_COMPLETION_INSTRUCTIONS}`
    );
  });
});
