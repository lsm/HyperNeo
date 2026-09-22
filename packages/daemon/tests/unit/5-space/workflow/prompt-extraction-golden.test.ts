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
  CODER_EXTERNAL_GATE_BLOCK: 'c6ead6d78a14a82de9e2cea7517f6635b2b8bde679f4e803ee07fef718f1add0',
  CODER_ONLY_MERGE_INSTRUCTIONS: '7c7a2bf70e24ceafb47b870568168ad0475b9cc72027f9a27fe3d00cd89c8cd1',
  CODER_ONLY_PROMPT: 'c195c7cd515f31cc94744644506face9522419ff039f33e436eb467cf6d34f56',
  CODER_OWNED_MERGE_INSTRUCTIONS:
    '8a76de23f601fed2e3e14175c06fbfef6f0d9ddd1bc940756e8bc543a95b7738',
  CODER_OWNED_MERGE_PROMPT: 'be82fbce636f574705734c640135375c11ad9db1f7814982de8e189745b8e6b2',
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE:
    '849ec685a272e0a751689014bd717b5e2103ccfb02d6b5b18e90eaad86bbb6e1',
  CODER_OWNED_QA_PROMPT: '19a4dd0eb95ea9173bfb902a521442650d7701300a1b4887ff92381b365264ae',
  CODER_OWNED_QA_REVIEW_PROMPT: 'd604b932f4630c5f58a793275c891425038a939fb91f20c5fa4e93fa822c7b53',
  CODER_OWNED_REVIEW_PROMPT: '25fa91c3f21b48d3b781ed96ce911973b8c7baebd3bf2961aaa503efad21b7fc',
  EXTERNAL_REVIEW_BOTS_GUIDANCE: 'a175421bc964e9a358ae65b9ac991ef4b39d16e8485e75d56107934b56c37b6d',
  FULLSTACK_CODING_NOCHANGE_GUIDANCE:
    '1fd1e433787a2e4223a866a5a9c83c414a73ce045b7293fdd868e5ce70568617',
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH:
    'd84327ea3ab84bca4fc17f30a65c8b90ddefc7d0720520f8607c09962fdaf483',
  RESEARCH_PROMPT: '5953b12800102884642c0c23b59bde79c56e43a666dea8dd74aeef7e394a7732',
  RESEARCH_REVIEW_PROMPT: '4ad09d0b7919d9a444f1114eca0d9cb67795a302a5532862a640c660ff6b3f6f',
  REVIEW_ONLY_REVIEW_PROMPT: 'f3d478e0c8ccf53a32817e353278422cc7fd22e6d51a5498fb6f5e123558f831',
  CALL_ACTION_PREFERENCE_GUIDANCE:
    'b9ac1ea8e25e91d43a0e9492cedd3517b276c3afa34f9f6c8ec3f528837c7131',
  REVIEW_POLICY_GUIDANCE: '6ba821ea3dd2c230a4bd44cf70f17f24bcecf0741e99f68978a689c7904fddf7',
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH:
    'a86da78d4d26ac27bf38510364b449a905abc3421297fffd180f62ee1c585c60',
  REVIEWER_ZERO_FINDINGS_GATE: '779ca229919ae834e0038d093e6d69e2fb8d383bb65cc395cbb5136060629979',
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
  QA_SYSTEM_CONTRACT: '7075de8fef82bd84a06c5345c2b5ed6118e374709ca6ca8ef3d5ec1563e0e2bc',
  REVIEWER_SYSTEM_CONTRACT: '9e102d20a7faa1d0b5b6c9290ff17c91e5ad9f2dd8be9f3500af7422f9d19be0',
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
      ['save_artifact', 'workflow.run.artifact.save'],
      ['submit_for_approval', 'task.transition'],
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
      const references = [
        ...text.matchAll(/\b(?:(?:workflow\.run\.)?artifact|task)\.[A-Za-z]+\b/g),
      ].map((match) => match[0]);
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
