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
import { ROUTER_AGENT_SYSTEM_PROMPT } from '../../../../src/lib/github/prompts/router-prompt.ts';
import { SECURITY_AGENT_SYSTEM_PROMPT } from '../../../../src/lib/github/prompts/security-prompt.ts';
import { buildTitleGenerationPrompt } from '../../../../src/lib/session/session-lifecycle.ts';
import { NON_DELEGATING_GENERAL_AGENT } from '../../../../src/lib/space/agents/custom-agent.ts';
import { getLongHorizonAgentTemplates } from '../../../../src/lib/space/agents/long-horizon-agent-templates.ts';
import { LONG_HORIZON_SCHEDULING_GUARDRAIL } from '../../../../src/lib/space/agents/long-horizon-agent-tools.ts';
import {
  getPresetAgentTemplates,
  LEGACY_REVIEWER_PROMPT,
} from '../../../../src/lib/space/agents/seed-agents.ts';
import { buildSpaceChatSystemPrompt } from '../../../../src/lib/space/agents/space-chat-agent.ts';
import {
  QA_SYSTEM_CONTRACT,
  REVIEWER_SYSTEM_CONTRACT,
} from '../../../../src/lib/space/agents/system-contracts.ts';
import { buildSelectionPrompt } from '../../../../src/lib/space/runtime/llm-workflow-selector.ts';
import { appendPostApprovalCompletionInstructions } from '../../../../src/lib/space/runtime/post-approval-router.ts';
import { buildPromptTooLongContinueNag } from '../../../../src/lib/space/runtime/prompt-too-long-recovery.ts';
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
  CODER_EXTERNAL_GATE_BLOCK: '05e1df1182f539cffb66cb3592e8956ebc97297a93680912c5a7f3ede466ac7c',
  CODER_ONLY_MERGE_INSTRUCTIONS: '70021ee7239f20c53eb174242761ac88356897fb0a79eed659bb2bb328500ab0',
  CODER_ONLY_PROMPT: 'a02f1164ea913ee3cbb16d52e9a6ab290ca7c023f9b26ab1a237f6eedf8c0570',
  CODER_OWNED_MERGE_INSTRUCTIONS:
    '89548177194eef9ae5c5d8c30dca09afea7e9bdf05a7715fee5385d17372d5c8',
  CODER_OWNED_MERGE_PROMPT: '1bff3cfde18dc5a064220ff55789b0c2b8ca901aea44f749978426b1b4e77b47',
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE:
    '849ec685a272e0a751689014bd717b5e2103ccfb02d6b5b18e90eaad86bbb6e1',
  CODER_OWNED_QA_PROMPT: 'c6f0237c984fa5b24d4232a4b0e7c3a1ba1aeff41ec0072aa58c6145beb3ed9a',
  CODER_OWNED_QA_REVIEW_PROMPT: '8f5a5d06d2dbd5f5e8e13dcfe7d7372f544346db93b58c7abb79a74c031c972b',
  CODER_OWNED_REVIEW_PROMPT: '605a927dfd09266988f778f779a5a719b2e707ea0d5182c29fe1a8f74e12cd03',
  EXTERNAL_REVIEW_BOTS_GUIDANCE: 'ae47a5b7eaca15695e29378c8f4a0ebaa683929f388638e28481607acede5f7e',
  FULLSTACK_CODING_NOCHANGE_GUIDANCE:
    '86a3ade926943f86121cf6f3779b5fe405f0a9a4793415e608e8902e20250823',
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH:
    '11a9d349054ebcd44dbbb4a5d3918a175446763b108d34c2db0a174fdfdc6e23',
  RESEARCH_PROMPT: '4acf1fe97327984d2c72750cc3d58a5ed12a986fe40245019c84c9b692d16a04',
  RESEARCH_REVIEW_PROMPT: '7c745458641b56475a18e3c4d2f38c3ffb0b2cbd9b8863bb4e2bb8776443e4dd',
  REVIEW_ONLY_REVIEW_PROMPT: 'db2f4cc6c11cd60310209d3d6a7d183a935b7556112e546d2fb17fc7cc3ccfe0',
  CALL_ACTION_PREFERENCE_GUIDANCE:
    'b762c651902ae11edc0805e24940a632c5ff5c49c00d63b64bf64af1324923ec',
  REVIEW_POLICY_GUIDANCE: '6ba821ea3dd2c230a4bd44cf70f17f24bcecf0741e99f68978a689c7904fddf7',
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH:
    'b399387063580e372b016032778074006db391065bb8b80793b701239b45de0c',
  REVIEWER_ZERO_FINDINGS_GATE: '6c8ce493c0f210efa5687cefb6494fb7f6a2261731f57ef32c60183f68fc4bce',
  REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE:
    '1815eaf2b9369f95d8a5742891ef38ba2fdcf50de8f8f18234831febb70b65d0',
  REVIEW_THREAD_RESOLUTION_GUIDANCE:
    '48b32262a1df32c43b4f87933592e1e222c8c7f6b731dac27eede79b61c14ee9',
  LEGACY_REVIEWER_PROMPT: '3d62ec5b500028f9513df1c9d4cd6dad24a8e956026a12969fc59c7117c76d8d',
  LH_COORDINATOR_INSTRUCTIONS: '1dcc66b10b2a3ef3f2f4949a669be1a9558c00582dd906fbfb1b23c49c9e017f',
  LONG_HORIZON_SCHEDULING_GUARDRAIL:
    '6d2a817133c3451c479e65394941c4b3886757ba7d0d6cfb6952b5063b4860e0',
  NON_DELEGATING_GENERAL_PROMPT: '5543aeae7a2a3aac9c5a4f9b489e3849c0998cb5e1d82b20e383da876fc5ae89',
  PRESET_CODER_PROMPT: '57b0ef8003e8e0ddea9aa4bb44404e1a8367fe43991c421046ca348d96fb1911',
  PRESET_RESEARCH_PROMPT: 'acc05ba0296ae52784b5477f97bd7246446644510c8e8228540f6387bcd8495e',
  QA_SYSTEM_CONTRACT: '60ea7a78cff979f2bcd8269108da1c47e67d411d170ca071407c81b270f41d51',
  REVIEWER_SYSTEM_CONTRACT: '5a6c8e8dce816c23fa409341b6a166eb9e0d6f8efa14f36d4ef8df41105c3671',
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
  CALL_ACTION_PREFERENCE_GUIDANCE,
  CODER_OWNED_MERGE_INSTRUCTIONS,
  QA_SYSTEM_CONTRACT,
  REVIEWER_SYSTEM_CONTRACT,
  LEGACY_REVIEWER_PROMPT,
  LH_COORDINATOR_INSTRUCTIONS: lhInstructions.get('LH_COORDINATOR_INSTRUCTIONS')!,
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

describe('workflow prompts prefer call_action with named-action fallback', () => {
  const DISPATCHER_PROMPTS: Record<string, string> = {
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

  test('every workflow role prompt and merge instruction carries the coexistence prose', () => {
    for (const [id, text] of Object.entries(DISPATCHER_PROMPTS)) {
      expect(text, id).toContain('prefer `call_action(name, params)`');
      expect(text, id).toContain('fall back to the typed tool of the same name');
      expect(text, id).toContain('call_action(name="list_actions")');
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
      const usedBy = Object.entries(DISPATCHER_PROMPTS).filter(([, text]) =>
        text.replace(CALL_ACTION_PREFERENCE_GUIDANCE, '').includes(name)
      );
      expect(usedBy.length, name).toBeGreaterThan(0);
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
  SPACE_CHAT_ASSEMBLED_EMPTY: '9b2c54680fa9191a15fdbc52faae9d29871ce373d153c7fd08ad4c39c46fe753',
  SPACE_CHAT_ASSEMBLED_L1: '38274820e7c011d6be3580f4ea3a35b8774e1c72af1211abba0595d9dfae6ed4',
  SPACE_CHAT_ASSEMBLED_L2: 'b84075e20ac1512681395324e7aecb3dd434250e1d508a11f7389d0c14ba463b',
  SPACE_CHAT_ASSEMBLED_L3: '285a0e1b923f3bdc5305195c21564e8031b785cc84b819a6c4702d883e04e5b1',
  SPACE_CHAT_ASSEMBLED_L4: 'c03d062b92eeef5245b63465324fab1cf4a071c0ad9d430ca7d4cb988b1c78bd',
  SPACE_CHAT_ASSEMBLED_L5: '9e7d8ff34d99c07d6ac65b6896384f4ccb1ea8c4b46975c33db6238dcf54e946',
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
