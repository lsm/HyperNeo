import { describe, expect, test } from 'bun:test';
import { POST_APPROVAL_COMPLETION_INSTRUCTIONS } from '@hyperneo/prompts';
import { createHash } from 'node:crypto';
import {
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
} from '../../../../src/lib/space/workflows/built-in-workflows.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from '../../../../src/lib/space/workflows/post-approval-merge-template.ts';
import {
  QA_SYSTEM_CONTRACT,
  REVIEWER_SYSTEM_CONTRACT,
} from '../../../../src/lib/space/agents/system-contracts.ts';
import {
  LEGACY_REVIEWER_PROMPT,
  getPresetAgentTemplates,
} from '../../../../src/lib/space/agents/seed-agents.ts';
import { getLongHorizonAgentTemplates } from '../../../../src/lib/space/agents/long-horizon-agent-templates.ts';
import { LONG_HORIZON_SCHEDULING_GUARDRAIL } from '../../../../src/lib/space/agents/long-horizon-agent-tools.ts';
import { NON_DELEGATING_GENERAL_AGENT } from '../../../../src/lib/space/agents/custom-agent.ts';
import { COORDINATOR_AGENT } from '../../../../src/lib/agent/coordinator/coordinator.ts';
import { coderAgent } from '../../../../src/lib/agent/coordinator/coder.ts';
import { reviewerAgent } from '../../../../src/lib/agent/coordinator/reviewer.ts';
import { debuggerAgent } from '../../../../src/lib/agent/coordinator/debugger.ts';
import { testerAgent } from '../../../../src/lib/agent/coordinator/tester.ts';
import { vcsAgent } from '../../../../src/lib/agent/coordinator/vcs.ts';
import { verifierAgent } from '../../../../src/lib/agent/coordinator/verifier.ts';
import { ROUTER_AGENT_SYSTEM_PROMPT } from '../../../../src/lib/github/prompts/router-prompt.ts';
import { SECURITY_AGENT_SYSTEM_PROMPT } from '../../../../src/lib/github/prompts/security-prompt.ts';
import { buildSpaceChatSystemPrompt } from '../../../../src/lib/space/agents/space-chat-agent.ts';
import { buildTitleGenerationPrompt } from '../../../../src/lib/session/session-lifecycle.ts';
import { appendPostApprovalCompletionInstructions } from '../../../../src/lib/space/runtime/post-approval-router.ts';
import { buildPromptTooLongContinueNag } from '../../../../src/lib/space/runtime/prompt-too-long-recovery.ts';
import { buildSelectionPrompt } from '../../../../src/lib/space/runtime/llm-workflow-selector.ts';

const GOLDEN: Record<string, string> = {
  CODEX_REACTION_APPROVAL_GUIDANCE:
    'b52db95c407c8c7d8f18d46d745bebaa5d449b8cbbd592627f87c67104aecf22',
  CODER_EXTERNAL_GATE_BLOCK: '4211c0cd90486578bc80b4edfb0611717e46d0958cd8dcece74c6dbbc8bab4ee',
  CODER_ONLY_MERGE_INSTRUCTIONS: '9b5ec05e3358cf98af18119f8f90d478e280cd3ec325e441b9739f695bb9e703',
  CODER_ONLY_PROMPT: '1f0653c5b3e1f04d1180903f0c790fb77c193c98411f145d15e1e047444f09a6',
  CODER_OWNED_MERGE_INSTRUCTIONS:
    '5825dfc9802a1ecd586550c603544c4ee648e9774e048806e481f75c39ac138b',
  CODER_OWNED_MERGE_PROMPT: '845ac390587a48621ac115ec5859797728c28b25c0f4c777b6855c401ca50999',
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE:
    '849ec685a272e0a751689014bd717b5e2103ccfb02d6b5b18e90eaad86bbb6e1',
  CODER_OWNED_QA_PROMPT: '99b0c9aa2b7cbc2da3e758c14bb926012f74e233737b0b66892288ac8bbedcc4',
  CODER_OWNED_QA_REVIEW_PROMPT: 'f915282840b18893b1200da0d648e2e37032b9488492674ac5d4ed1fefe80f20',
  CODER_OWNED_REVIEW_PROMPT: 'da51558acb0459acf61beda09a4390557966320dd0ab95d74b115dfd5e940740',
  EXTERNAL_REVIEW_BOTS_GUIDANCE: 'e731d02a5b4688f65f658fc0c98c5bcd0a339c95cc48b5c8b8e7856210d8d09a',
  FULLSTACK_CODING_NOCHANGE_GUIDANCE:
    '86a3ade926943f86121cf6f3779b5fe405f0a9a4793415e608e8902e20250823',
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH:
    '11a9d349054ebcd44dbbb4a5d3918a175446763b108d34c2db0a174fdfdc6e23',
  RESEARCH_PROMPT: '9990545909f680cfc51a329ad13a9ba00bc6a8a60b5615b0f1df6cac59c95083',
  RESEARCH_REVIEW_PROMPT: '199f7ad7c972d1495f978924a26cff953680c8fddf73f33e25de3b0bb4621c56',
  REVIEW_ONLY_REVIEW_PROMPT: '9e223b7e6c1c306e66288916cc42e2f5f7211b997cfaf3db06f9ecb7033317ee',
  REVIEW_POLICY_GUIDANCE: '6ba821ea3dd2c230a4bd44cf70f17f24bcecf0741e99f68978a689c7904fddf7',
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH:
    'b399387063580e372b016032778074006db391065bb8b80793b701239b45de0c',
  REVIEWER_ZERO_FINDINGS_GATE: '6c8ce493c0f210efa5687cefb6494fb7f6a2261731f57ef32c60183f68fc4bce',
  REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE:
    '1815eaf2b9369f95d8a5742891ef38ba2fdcf50de8f8f18234831febb70b65d0',
  REVIEW_THREAD_RESOLUTION_GUIDANCE:
    '48b32262a1df32c43b4f87933592e1e222c8c7f6b731dac27eede79b61c14ee9',
  LEGACY_REVIEWER_PROMPT: '3d62ec5b500028f9513df1c9d4cd6dad24a8e956026a12969fc59c7117c76d8d',
  LH_COORDINATOR_INSTRUCTIONS: '3ad4c70290353ac4adc628be02e445978dd84e8352c9a4d73138726fefde7186',
  LH_FAMILY_OPS_CHORES_INSTRUCTIONS:
    '1f7aecb617e6b1030ac12cdd3db150cd0b829d2c528e83b93ece1a687caeffe1',
  LH_MARKETING_INSTRUCTIONS: 'aeb3070d297e716f080aa91ecb8229f1ccd6a428687cb0e68da75e447d111a85',
  LH_PRODUCT_QUALITY_MANAGER_INSTRUCTIONS:
    '1f0ab7651c39a95199c78540b642a5de9615f5c82b257d7877118207299e1bf6',
  LH_RELEASE_MANAGER_INSTRUCTIONS:
    '7e385c5a894077c9b1a4e44552c1a0239f5b6fd03a43e84948e4fc8b77b94ca7',
  LH_RESEARCH_INSTRUCTIONS: '4d46c03990448a09a309461b1cbe154432e92a436fd0ccf9daa59ee64144b9fd',
  LH_SALES_INSTRUCTIONS: '992b642206d9228f03eb6a6814bb3038214d62f04b8530b047a33fea3a202a40',
  LH_SECURITY_AUDITOR_INSTRUCTIONS:
    'ae6464a7ff859d587842590436d108bcc8d7114f2b8960071ff8c7c042caa8aa',
  LONG_HORIZON_SCHEDULING_GUARDRAIL:
    '6d2a817133c3451c479e65394941c4b3886757ba7d0d6cfb6952b5063b4860e0',
  NON_DELEGATING_GENERAL_PROMPT: '5543aeae7a2a3aac9c5a4f9b489e3849c0998cb5e1d82b20e383da876fc5ae89',
  PRESET_CODER_PROMPT: '57b0ef8003e8e0ddea9aa4bb44404e1a8367fe43991c421046ca348d96fb1911',
  PRESET_GENERAL_PROMPT: 'bceb32ddc7871655ce2db944ce1e392fe21d22ea392beeede19def976d710d26',
  PRESET_PLANNER_PROMPT: '73b46e357edffdbf9e6068ffda8d81e5701eccb81777714459860502c6e6e9ee',
  PRESET_RESEARCH_PROMPT: 'acc05ba0296ae52784b5477f97bd7246446644510c8e8228540f6387bcd8495e',
  QA_SYSTEM_CONTRACT: '28c9d2cb8b39f3b422f651ae23c777214ec097e723943179e2a9166ef77a72b4',
  REVIEWER_SYSTEM_CONTRACT: '6a163beec33068dbc21a226286a0003ab31cce11fa735bd4162f9dd0ab0b0604',
  COORDINATOR_PROMPT: '28f30cf29ed5764a703a90029dc468c5e905dc8eb057abf1779e3e5ce9e25487',
  GITHUB_ROUTER_SYSTEM_PROMPT: '39f3b5c43689366029c130b0aa0d1a83c185ef527671cae1d858ed6213e322a6',
  GITHUB_SECURITY_SYSTEM_PROMPT: '486aff88bf9a9c66ac69abe074270c5c538a1433c81dc126228f97de5f65c9bd',
  SUBAGENT_CODER_PROMPT: '5f01cfb2266c6f8a2d154da7aea4162e2297236545bcad2248447a974d6a1dac',
  SUBAGENT_DEBUGGER_PROMPT: '844cd806780d789b9d24466d7157be365e87a55064fa1108681ec7510b12aed1',
  SUBAGENT_REVIEWER_PROMPT: '3d62ec5b500028f9513df1c9d4cd6dad24a8e956026a12969fc59c7117c76d8d',
  SUBAGENT_TESTER_PROMPT: '9197c4c373bd99d8b3fb88dd7ed98788cd30521ca710c8adc8be139983a40bad',
  SUBAGENT_VCS_PROMPT: 'ea28eae3d3fb3291df5324077b0f7d602ff9abe8222ffb2eec71c69fedbdb2b1',
  SUBAGENT_VERIFIER_PROMPT: 'b5c24ec4a2b90c6ddc5b851e33e14da2fad554c528fa93027a9bc5a08dbfbfe0',
  POST_APPROVAL_COMPLETION_INSTRUCTIONS:
    '75598a241dc358e67b88139046bd4947d503c47520a091dc68bfbbdb54321f1f',
  PROMPT_TOO_LONG_CONTINUE_NAG: '6087c6a95dc3d926b9c7e683ea1f125dc8fd26052b6291c93fab1d0512f79005',
  TITLE_GENERATION_PROMPT: '90eb78808852b1639e84818f8447dcb02a2b3f9e2e1fb664edf54c930c3610dd',
  WORKFLOW_SELECTOR_INSTRUCTIONS:
    'edacda28ae7fb8b7eb43631c3324b3fa8e01a82ea096313fcb7057bede914d83',
};

const byPreset = new Map(getPresetAgentTemplates().map((p) => [p.handle, p.customPrompt]));
const lhInstructions = new Map(
  getLongHorizonAgentTemplates().map((t) => [
    `LH_${t.key.replace('.default', '').toUpperCase().replace(/-/g, '_')}_INSTRUCTIONS`,
    t.instructions,
  ])
);

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
  CODER_OWNED_MERGE_INSTRUCTIONS,
  QA_SYSTEM_CONTRACT,
  REVIEWER_SYSTEM_CONTRACT,
  LEGACY_REVIEWER_PROMPT,
  LH_COORDINATOR_INSTRUCTIONS: lhInstructions.get('LH_COORDINATOR_INSTRUCTIONS')!,
  LH_FAMILY_OPS_CHORES_INSTRUCTIONS: lhInstructions.get('LH_FAMILY_OPS_CHORES_INSTRUCTIONS')!,
  LH_MARKETING_INSTRUCTIONS: lhInstructions.get('LH_MARKETING_INSTRUCTIONS')!,
  LH_PRODUCT_QUALITY_MANAGER_INSTRUCTIONS: lhInstructions.get(
    'LH_PRODUCT_QUALITY_MANAGER_INSTRUCTIONS'
  )!,
  LH_RELEASE_MANAGER_INSTRUCTIONS: lhInstructions.get('LH_RELEASE_MANAGER_INSTRUCTIONS')!,
  LH_RESEARCH_INSTRUCTIONS: lhInstructions.get('LH_RESEARCH_INSTRUCTIONS')!,
  LH_SALES_INSTRUCTIONS: lhInstructions.get('LH_SALES_INSTRUCTIONS')!,
  LH_SECURITY_AUDITOR_INSTRUCTIONS: lhInstructions.get('LH_SECURITY_AUDITOR_INSTRUCTIONS')!,
  LONG_HORIZON_SCHEDULING_GUARDRAIL,
  NON_DELEGATING_GENERAL_PROMPT: NON_DELEGATING_GENERAL_AGENT.prompt,
  PRESET_CODER_PROMPT: byPreset.get('coder')!,
  PRESET_GENERAL_PROMPT: byPreset.get('general')!,
  PRESET_PLANNER_PROMPT: byPreset.get('planner')!,
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
  GITHUB_ROUTER_SYSTEM_PROMPT: ROUTER_AGENT_SYSTEM_PROMPT,
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

const SPACE_CHAT_FIXTURE = {
  background: 'FIXTURE_BACKGROUND',
  instructions: 'FIXTURE_INSTRUCTIONS',
  workflows: [{ name: 'FIX WF', id: 'fix-wf', nodeCount: 2, tags: ['coding'] }],
  agents: [{ name: 'FIX AG', description: 'fixture agent' }],
};

const ASSEMBLED_GOLDEN: Record<string, string> = {
  SPACE_CHAT_ASSEMBLED_EMPTY: '28b742050181d4753fccdb58e95c9ee0ae7a1ef74ac7c6edd4a9729ed8391a90',
  SPACE_CHAT_ASSEMBLED_L1: '7bdb8a79b1e3d7e952a0cbc965b73924e99d0769845f5967ef62b31410ee5889',
  SPACE_CHAT_ASSEMBLED_L2: 'f5535c3e96398bc540a0101a7cf0cb8cf706923b3952535ac16bd1526eb7b9bc',
  SPACE_CHAT_ASSEMBLED_L3: '1a06198e884adcb39b5ff1b1ebebe8cad717f02999f93d80d3abde8a8f5a6e2a',
  SPACE_CHAT_ASSEMBLED_L4: '9df690346f5f16741542eee4e10b0df2c28434dc52ca7e37bd449db92c7e6e5d',
  SPACE_CHAT_ASSEMBLED_L5: 'd1d6a4df85083dac8ad17aefc5203fe9f7d383468d65fa5a535244b83b4f1868',
};

describe('space-chat system prompt assembly', () => {
  test('assembled prompts are byte-identical across all autonomy levels', () => {
    for (const level of [1, 2, 3, 4, 5]) {
      const actual = createHash('sha256')
        .update(
          buildSpaceChatSystemPrompt({ ...SPACE_CHAT_FIXTURE, autonomyLevel: level } as never)
        )
        .digest('hex');
      expect(actual, `level ${level}`).toBe(ASSEMBLED_GOLDEN[`SPACE_CHAT_ASSEMBLED_L${level}`]!);
    }
    const empty = createHash('sha256').update(buildSpaceChatSystemPrompt({})).digest('hex');
    expect(empty).toBe(ASSEMBLED_GOLDEN['SPACE_CHAT_ASSEMBLED_EMPTY']!);
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
