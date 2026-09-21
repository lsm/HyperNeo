import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  CALL_ACTION_PREFERENCE_GUIDANCE,
  POST_APPROVAL_COMPLETION_INSTRUCTIONS,
} from '@hyperneo/prompts';
import { isOperationName } from '@hyperneo/shared/types/operation-names';
import { coderAgent } from '../../../../src/lib/agent/coordinator/coder.ts';
import { COORDINATOR_AGENT } from '../../../../src/lib/agent/coordinator/coordinator.ts';
import { debuggerAgent } from '../../../../src/lib/agent/coordinator/debugger.ts';
import { reviewerAgent } from '../../../../src/lib/agent/coordinator/reviewer.ts';
import { testerAgent } from '../../../../src/lib/agent/coordinator/tester.ts';
import { vcsAgent } from '../../../../src/lib/agent/coordinator/vcs.ts';
import { verifierAgent } from '../../../../src/lib/agent/coordinator/verifier.ts';
import { NON_DELEGATING_GENERAL_AGENT } from '../../../../src/lib/agents/custom-agent.ts';
import { LONG_HORIZON_SCHEDULING_GUARDRAIL } from '../../../../src/lib/agents/long-horizon-tools.ts';
import {
  getPresetAgentTemplates,
  LEGACY_REVIEWER_PROMPT,
} from '../../../../src/lib/agents/seed-agents.ts';
import {
  QA_SYSTEM_CONTRACT,
  REVIEWER_SYSTEM_CONTRACT,
} from '../../../../src/lib/agents/system-contracts.ts';
import { SECURITY_AGENT_SYSTEM_PROMPT } from '../../../../src/lib/github/prompts/security-prompt.ts';
import { buildPromptTooLongContinueNag } from '../../../../src/lib/session/prompt-too-long-recovery.ts';
import { buildTitleGenerationPrompt } from '../../../../src/lib/session/session-lifecycle.ts';
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
} from '../../../../src/lib/workflows/built-in-workflows.ts';
import { buildSelectionPrompt } from '../../../../src/lib/workflows/llm-workflow-selector.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from '../../../../src/lib/workflows/post-approval-merge-template.ts';
import { appendPostApprovalCompletionInstructions } from '../../../../src/lib/workflows/post-approval-route-selection.ts';

const GOLDEN: Record<string, string> = {
  CODEX_REACTION_APPROVAL_GUIDANCE:
    '2e1dbf1a39b2c9b47dc930c2614e3d85c93d0ea2175d3149162262725a4966be',
  CODER_EXTERNAL_GATE_BLOCK: '46759a7df7b261a2977e3edc20927754ca7611f06ab71d74f353bff4e5e51ad8',
  CODER_ONLY_MERGE_INSTRUCTIONS: 'ad5092a4c19d0fec5ffc056bd938ddef1a75c67476a7107d3f8c0e5d7a63a75f',
  CODER_ONLY_PROMPT: '510215c53af575aaae96b3c3ffc772915c250144591e17dd71d3cd9178ec23fe',
  CODER_OWNED_MERGE_INSTRUCTIONS:
    'e042e6d3cd7f4f97d2b91e5ec59aba983ac779244932575a68be35a81becca5c',
  CODER_OWNED_MERGE_PROMPT: '126116ddc44a30d4cdcec547ade394e5a948950bf54a0c4be5d8a0a429be4486',
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE:
    '849ec685a272e0a751689014bd717b5e2103ccfb02d6b5b18e90eaad86bbb6e1',
  CODER_OWNED_QA_PROMPT: '7f9bef2bb746df3d8dc7f030f14722a4d9b5fc5f5b172283139aad928ef60420',
  CODER_OWNED_QA_REVIEW_PROMPT: '65ea0b5305f3eaa717c8d09d811ac76722e80f3b7d83c6fc098fff76d85dc594',
  CODER_OWNED_REVIEW_PROMPT: '367547613c795cf9cbb3fc7d1db6c534c9d88b0a0542f12f42a6f9f82292830e',
  EXTERNAL_REVIEW_BOTS_GUIDANCE: 'ab4d0a12c242d503c87fba14ffb379001b5228bfdbfdb3262a2832eaee85d1fd',
  FULLSTACK_CODING_NOCHANGE_GUIDANCE:
    '299ca05ccf28d04d57273b4988dc986a2a89f799eee91955075eed8d096f6977',
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH:
    'd84327ea3ab84bca4fc17f30a65c8b90ddefc7d0720520f8607c09962fdaf483',
  RESEARCH_PROMPT: '6275916abb91f9f7d3092481c85e4b4d4e910b74bcada7c9979aee454dacf5eb',
  RESEARCH_REVIEW_PROMPT: 'ba731f0e99a63d69ba00ff82f8824db4a1a23f45b6bda5bfde5fc90d0dd4593f',
  REVIEW_ONLY_REVIEW_PROMPT: 'cd6c01f89e09ca0ac1c98a44f9ad1acfc9126496caaa4b7a084790f849621a63',
  CALL_ACTION_PREFERENCE_GUIDANCE:
    'ffe7bd6605340b0665b922007c698e8582f99d3b9869178fc795c9ce35665851',
  REVIEW_POLICY_GUIDANCE: '6ba821ea3dd2c230a4bd44cf70f17f24bcecf0741e99f68978a689c7904fddf7',
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH:
    'a86da78d4d26ac27bf38510364b449a905abc3421297fffd180f62ee1c585c60',
  REVIEWER_ZERO_FINDINGS_GATE: 'd82da0a628e91ccc8c0dd4cfdb9c01966af19d4088c3a593891ef6f0ea196c57',
  REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE:
    '1815eaf2b9369f95d8a5742891ef38ba2fdcf50de8f8f18234831febb70b65d0',
  REVIEW_THREAD_RESOLUTION_GUIDANCE:
    '48b32262a1df32c43b4f87933592e1e222c8c7f6b731dac27eede79b61c14ee9',
  LEGACY_REVIEWER_PROMPT: '3d62ec5b500028f9513df1c9d4cd6dad24a8e956026a12969fc59c7117c76d8d',
  LONG_HORIZON_SCHEDULING_GUARDRAIL:
    '8bf7fc11d49d2793bc18c698be32bc12c9cb2aedbdfcca759453beed6aa2991e',
  NON_DELEGATING_GENERAL_PROMPT: '5543aeae7a2a3aac9c5a4f9b489e3849c0998cb5e1d82b20e383da876fc5ae89',
  PRESET_CODER_PROMPT: '57b0ef8003e8e0ddea9aa4bb44404e1a8367fe43991c421046ca348d96fb1911',
  PRESET_RESEARCH_PROMPT: 'acc05ba0296ae52784b5477f97bd7246446644510c8e8228540f6387bcd8495e',
  QA_SYSTEM_CONTRACT: '88a923c55c6bc59e1e8be18f9f2fde2b8fe3441a0bc4598eaeb9f24cb57021d3',
  REVIEWER_SYSTEM_CONTRACT: 'ef659dcd6ad7264a2aa4a22c3b8fdda01f4e07ae2601295b5d245f42383cd478',
  COORDINATOR_PROMPT: '28f30cf29ed5764a703a90029dc468c5e905dc8eb057abf1779e3e5ce9e25487',
  GITHUB_SECURITY_SYSTEM_PROMPT: '486aff88bf9a9c66ac69abe074270c5c538a1433c81dc126228f97de5f65c9bd',
  SUBAGENT_CODER_PROMPT: '5f01cfb2266c6f8a2d154da7aea4162e2297236545bcad2248447a974d6a1dac',
  SUBAGENT_DEBUGGER_PROMPT: '844cd806780d789b9d24466d7157be365e87a55064fa1108681ec7510b12aed1',
  SUBAGENT_REVIEWER_PROMPT: '3d62ec5b500028f9513df1c9d4cd6dad24a8e956026a12969fc59c7117c76d8d',
  SUBAGENT_TESTER_PROMPT: '9197c4c373bd99d8b3fb88dd7ed98788cd30521ca710c8adc8be139983a40bad',
  SUBAGENT_VCS_PROMPT: 'ea28eae3d3fb3291df5324077b0f7d602ff9abe8222ffb2eec71c69fedbdb2b1',
  SUBAGENT_VERIFIER_PROMPT: 'b5c24ec4a2b90c6ddc5b851e33e14da2fad554c528fa93027a9bc5a08dbfbfe0',
  POST_APPROVAL_COMPLETION_INSTRUCTIONS:
    '9fcb979bb16e533f33d6edd441f526fdf34990743e6813ea9664c345f6283267',
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
  test('separates the coder-only introduction from the review policy', () => {
    expect(CODER_ONLY_PROMPT).toContain('repository. ### Review policy');
  });

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

  test('active prompts contain no fictional typed-tool calls outside migration guidance', () => {
    for (const [id, text] of Object.entries({
      ...OPERATION_DOOR_PROMPTS,
      QA_SYSTEM_CONTRACT,
      REVIEWER_SYSTEM_CONTRACT,
      FULLSTACK_CODING_NOCHANGE_GUIDANCE,
      FULLSTACK_QA_POST_APPROVAL_PARAGRAPH,
    })) {
      expect(text.replace(CALL_ACTION_PREFERENCE_GUIDANCE, ''), id).not.toMatch(
        /\b(?:save_artifact|submit_for_approval|approve_task|mark_complete|update_task|approve_pending_completion)\b/
      );
    }
  });

  test('the preference prose maps each retired typed tool to a declared operation', () => {
    expect(CALL_ACTION_PREFERENCE_GUIDANCE).not.toContain('identical to the action name');
    for (const [tool, operation] of [
      ['save_artifact', 'artifact.save'],
      ['submit_for_approval', 'task.submitForReview'],
      ['approve_task', 'task.approve'],
      ['mark_complete', 'task.complete'],
    ]) {
      expect(CALL_ACTION_PREFERENCE_GUIDANCE, tool).toContain(`\`${tool}\` is \`${operation}\``);
      expect(isOperationName(operation!), operation).toBe(true);
    }
  });

  test('every invoke(name="…") target a prompt names is a declared operation', () => {
    const named: Record<string, string> = {
      CALL_ACTION_PREFERENCE_GUIDANCE,
      POST_APPROVAL_COMPLETION_INSTRUCTIONS,
      ...OPERATION_DOOR_PROMPTS,
      QA_SYSTEM_CONTRACT,
      REVIEWER_SYSTEM_CONTRACT,
    };
    for (const [id, text] of Object.entries(named)) {
      const targets = [...text.matchAll(/invoke\(name="([^"]+)"/g)].map((match) => match[1]!);
      const references = [...text.matchAll(/\b(?:artifact|task)\.[A-Za-z]+\b/g)].map(
        (match) => match[0]
      );
      targets.push(...references);
      for (const target of targets) {
        expect(isOperationName(target), `${id}: ${target}`).toBe(true);
      }
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
