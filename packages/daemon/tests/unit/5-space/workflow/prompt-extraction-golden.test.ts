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
  CODER_EXTERNAL_GATE_BLOCK: 'e4020f4406f182b4edd57a74bd17d1f7f3b7efeec017f7b1f5dd83d2790d720d',
  CODER_ONLY_MERGE_INSTRUCTIONS: '5a10fb80422b2922d8fbd7968705efa5f7ed9e141e564a5ae095e45444a37e10',
  CODER_ONLY_PROMPT: '4734136a319a617a14f71c7d57ecaa9cf8483324f74009112d4bce7fe7e16973',
  CODER_OWNED_MERGE_INSTRUCTIONS:
    'adb52987358f9b3b08a6ba795694810ee3bcae493adb36da64ad8cacbe9d02cf',
  CODER_OWNED_MERGE_PROMPT: 'd5fc7e211289f19d6a8112bd031b0361081ff2562679adc08b907150fa925121',
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE:
    '849ec685a272e0a751689014bd717b5e2103ccfb02d6b5b18e90eaad86bbb6e1',
  CODER_OWNED_QA_PROMPT: '3d7b364726a87787b7ea2d3a3a468b9ebcbd9b45a9d3573f4b91b3d54f3b8942',
  CODER_OWNED_QA_REVIEW_PROMPT: 'ac6a45761fc71e7d9d058c595b08f61eb5cc336d9e93320dc786df6185d70ff7',
  CODER_OWNED_REVIEW_PROMPT: 'd336ca8caf451075403a0989b1e487c84faca2ef5a2a89af18db4a9e37b0df7d',
  EXTERNAL_REVIEW_BOTS_GUIDANCE: '5cd7f3fe6b9a05536d0544461e1439fa01691ab4a6e821696975ac418af87933',
  FULLSTACK_CODING_NOCHANGE_GUIDANCE:
    '74f56a17289baccf098c526fe6397b8894414f6cd3fd8178af86f5e3a16b95a4',
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH:
    '77d86b527ae489e9b32394ddbe2ee72f1ac5b283fe065902e72485ce9fb62030',
  RESEARCH_PROMPT: '55f1fe5f85899b3f495197a5dd781f60afa7a3c791bf9e2649919a06d7cf59c8',
  RESEARCH_REVIEW_PROMPT: '31b0d7c27641fd3b39a87c5f4f751812df5cb643b7a87596094246c92333853e',
  REVIEW_ONLY_REVIEW_PROMPT: '61d503d32ae0226ce0f158d5e836a640793bf9587c22acf56d349d362902e22d',
  CALL_ACTION_PREFERENCE_GUIDANCE:
    '62f074f444b877af3aa0476324d65231cbb4ea0b6048e0853a644d6306859a34',
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
    '8bf7fc11d49d2793bc18c698be32bc12c9cb2aedbdfcca759453beed6aa2991e',
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
    'ecadf6b37434d39e68182fe70d8904ad7229d7e89f0f840820d8f9e1326d3157',
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

  test('the preference prose maps each retired typed tool to a declared operation', () => {
    expect(CALL_ACTION_PREFERENCE_GUIDANCE).not.toContain('identical to the action name');
    for (const [tool, operation] of [
      ['save_artifact', 'artifact.save'],
      ['submit_for_approval', 'task.submitForReview'],
      ['approve_task', 'task.resolvePendingCompletion'],
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
      REVIEW_ONLY_REVIEW_PROMPT,
    };
    for (const [id, text] of Object.entries(named)) {
      const targets = [...text.matchAll(/invoke\(name="([^"]+)"/g)].map((match) => match[1]!);
      expect(targets.length, id).toBeGreaterThan(0);
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
