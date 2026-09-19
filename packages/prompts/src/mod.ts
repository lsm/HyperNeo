/// <reference path="./markdown.d.ts" />

import mdagentsLongHorizonOwnerReviewContract from './agents/long-horizon/owner-review-contract.md' with {
  type: 'text',
};
import mdagentsLongHorizonTaskManager from './agents/long-horizon/task-manager.md' with {
  type: 'text',
};
import mdagentsLongHorizonSchedulingGuardrail from './agents/long-horizon-scheduling-guardrail.md' with {
  type: 'text',
};
import mdagentsNonDelegatingGeneral from './agents/non-delegating-general.md' with { type: 'text' };
import mdagentsPresetsCoder from './agents/presets/coder.md' with { type: 'text' };
import mdagentsPresetsGeneral from './agents/presets/general.md' with { type: 'text' };
import mdagentsPresetsLegacyReviewer from './agents/presets/legacy-reviewer.md' with {
  type: 'text',
};
import mdagentsPresetsPlanner from './agents/presets/planner.md' with { type: 'text' };
import mdagentsPresetsResearch from './agents/presets/research.md' with { type: 'text' };
import mdagentsSystemContractsQaSystemContract from './agents/system-contracts/qa-system-contract.md' with {
  type: 'text',
};
import mdagentsSystemContractsReviewerSystemContract from './agents/system-contracts/reviewer-system-contract.md' with {
  type: 'text',
};
import mdcommandsMergeSession from './commands/merge-session.md' with { type: 'text' };
import mdcoordinatorCoder from './coordinator/coder.md' with { type: 'text' };
import mdcoordinatorCoordinator from './coordinator/coordinator.md' with { type: 'text' };
import mdcoordinatorDebugger from './coordinator/debugger.md' with { type: 'text' };
import mdcoordinatorReviewer from './coordinator/reviewer.md' with { type: 'text' };
import mdcoordinatorTester from './coordinator/tester.md' with { type: 'text' };
import mdcoordinatorVcs from './coordinator/vcs.md' with { type: 'text' };
import mdcoordinatorVerifier from './coordinator/verifier.md' with { type: 'text' };
import mdgithubRouterSystemPrompt from './github/router-system-prompt.md' with { type: 'text' };
import mdgithubSecuritySystemPrompt from './github/security-system-prompt.md' with { type: 'text' };
import { buildPromptRegistry } from './loader.ts';
import mdruntimePostApprovalCompletion from './runtime/post-approval-completion.md' with {
  type: 'text',
};
import mdruntimePromptTooLongContinueNag from './runtime/prompt-too-long-continue-nag.md' with {
  type: 'text',
};
import mdruntimeWorkflowSelectorInstructions from './runtime/workflow-selector-instructions.md' with {
  type: 'text',
};
import mdsessionTitleGeneration from './session/title-generation.md' with { type: 'text' };
import mdspaceOperationsDoor from './space/operations-door.md' with { type: 'text' };
import mdworkflowsCoderOnlyMergeInstructions from './workflows/coder-only/merge-instructions.md' with {
  type: 'text',
};
import mdworkflowsCoderOnlyPrompt from './workflows/coder-only/prompt.md' with { type: 'text' };
import mdworkflowsCoderOwnedExternalGate from './workflows/coder-owned/external-gate.md' with {
  type: 'text',
};
import mdworkflowsCoderOwnedMergeInstructions from './workflows/coder-owned/merge-instructions.md' with {
  type: 'text',
};
import mdworkflowsCoderOwnedMergePrompt from './workflows/coder-owned/merge-prompt.md' with {
  type: 'text',
};
import mdworkflowsCoderOwnedQaPrompt from './workflows/coder-owned/qa-prompt.md' with {
  type: 'text',
};
import mdworkflowsCoderOwnedQaReviewPrompt from './workflows/coder-owned/qa-review-prompt.md' with {
  type: 'text',
};
import mdworkflowsCoderOwnedReviewPrompt from './workflows/coder-owned/review-prompt.md' with {
  type: 'text',
};
import mdworkflowsGuidanceCallActionPreference from './workflows/guidance/call-action-preference.md' with {
  type: 'text',
};
import mdworkflowsGuidanceCodexReactionApproval from './workflows/guidance/codex-reaction-approval.md' with {
  type: 'text',
};
import mdworkflowsGuidanceExternalReviewBots from './workflows/guidance/external-review-bots.md' with {
  type: 'text',
};
import mdworkflowsGuidanceFullstackCodingNochange from './workflows/guidance/fullstack-coding-nochange.md' with {
  type: 'text',
};
import mdworkflowsGuidanceFullstackQaPostApproval from './workflows/guidance/fullstack-qa-post-approval.md' with {
  type: 'text',
};
import mdworkflowsGuidanceRetiredCallActionPreferencePreOperationNames from './workflows/guidance/retired/call-action-preference-pre-operation-names.md' with {
  type: 'text',
};
import mdworkflowsGuidanceRetiredExternalReviewBotsPreCheckSeeding from './workflows/guidance/retired/external-review-bots-pre-check-seeding.md' with {
  type: 'text',
};
import mdworkflowsGuidanceRetiredExternalReviewBotsPreTypename from './workflows/guidance/retired/external-review-bots-pre-typename.md' with {
  type: 'text',
};
import mdworkflowsGuidanceReviewPolicy from './workflows/guidance/review-policy.md' with {
  type: 'text',
};
import mdworkflowsGuidanceReviewThreadApprovalCheck from './workflows/guidance/review-thread-approval-check.md' with {
  type: 'text',
};
import mdworkflowsGuidanceReviewThreadResolution from './workflows/guidance/review-thread-resolution.md' with {
  type: 'text',
};
import mdworkflowsGuidanceReviewerPostApprovalBlocker from './workflows/guidance/reviewer-post-approval-blocker.md' with {
  type: 'text',
};
import mdworkflowsGuidanceReviewerZeroFindingsGate from './workflows/guidance/reviewer-zero-findings-gate.md' with {
  type: 'text',
};
import mdworkflowsGuidanceSubscribePrEvents from './workflows/guidance/subscribe-pr-events.md' with {
  type: 'text',
};
import mdworkflowsResearchResearchPrompt from './workflows/research/research-prompt.md' with {
  type: 'text',
};
import mdworkflowsResearchReviewPrompt from './workflows/research/review-prompt.md' with {
  type: 'text',
};
import mdworkflowsReviewOnlyReviewPrompt from './workflows/review-only/review-prompt.md' with {
  type: 'text',
};

const registry: Record<string, string> = {
  'agents/long-horizon-scheduling-guardrail.md': mdagentsLongHorizonSchedulingGuardrail,
  'agents/long-horizon/owner-review-contract.md': mdagentsLongHorizonOwnerReviewContract,
  'agents/long-horizon/task-manager.md': mdagentsLongHorizonTaskManager,
  'agents/non-delegating-general.md': mdagentsNonDelegatingGeneral,
  'agents/presets/coder.md': mdagentsPresetsCoder,
  'agents/presets/general.md': mdagentsPresetsGeneral,
  'agents/presets/legacy-reviewer.md': mdagentsPresetsLegacyReviewer,
  'agents/presets/planner.md': mdagentsPresetsPlanner,
  'agents/presets/research.md': mdagentsPresetsResearch,
  'agents/system-contracts/qa-system-contract.md': mdagentsSystemContractsQaSystemContract,
  'agents/system-contracts/reviewer-system-contract.md':
    mdagentsSystemContractsReviewerSystemContract,
  'commands/merge-session.md': mdcommandsMergeSession,
  'coordinator/coder.md': mdcoordinatorCoder,
  'coordinator/coordinator.md': mdcoordinatorCoordinator,
  'coordinator/debugger.md': mdcoordinatorDebugger,
  'coordinator/reviewer.md': mdcoordinatorReviewer,
  'coordinator/tester.md': mdcoordinatorTester,
  'coordinator/vcs.md': mdcoordinatorVcs,
  'coordinator/verifier.md': mdcoordinatorVerifier,
  'github/router-system-prompt.md': mdgithubRouterSystemPrompt,
  'github/security-system-prompt.md': mdgithubSecuritySystemPrompt,
  'runtime/post-approval-completion.md': mdruntimePostApprovalCompletion,
  'runtime/prompt-too-long-continue-nag.md': mdruntimePromptTooLongContinueNag,
  'runtime/workflow-selector-instructions.md': mdruntimeWorkflowSelectorInstructions,
  'session/title-generation.md': mdsessionTitleGeneration,
  'space/operations-door.md': mdspaceOperationsDoor,
  'workflows/coder-only/merge-instructions.md': mdworkflowsCoderOnlyMergeInstructions,
  'workflows/coder-only/prompt.md': mdworkflowsCoderOnlyPrompt,
  'workflows/coder-owned/external-gate.md': mdworkflowsCoderOwnedExternalGate,
  'workflows/coder-owned/merge-instructions.md': mdworkflowsCoderOwnedMergeInstructions,
  'workflows/coder-owned/merge-prompt.md': mdworkflowsCoderOwnedMergePrompt,
  'workflows/coder-owned/qa-prompt.md': mdworkflowsCoderOwnedQaPrompt,
  'workflows/coder-owned/qa-review-prompt.md': mdworkflowsCoderOwnedQaReviewPrompt,
  'workflows/coder-owned/review-prompt.md': mdworkflowsCoderOwnedReviewPrompt,
  'workflows/guidance/call-action-preference.md': mdworkflowsGuidanceCallActionPreference,
  'workflows/guidance/codex-reaction-approval.md': mdworkflowsGuidanceCodexReactionApproval,
  'workflows/guidance/external-review-bots.md': mdworkflowsGuidanceExternalReviewBots,
  'workflows/guidance/retired/call-action-preference-pre-operation-names.md':
    mdworkflowsGuidanceRetiredCallActionPreferencePreOperationNames,
  'workflows/guidance/retired/external-review-bots-pre-check-seeding.md':
    mdworkflowsGuidanceRetiredExternalReviewBotsPreCheckSeeding,
  'workflows/guidance/retired/external-review-bots-pre-typename.md':
    mdworkflowsGuidanceRetiredExternalReviewBotsPreTypename,
  'workflows/guidance/fullstack-coding-nochange.md': mdworkflowsGuidanceFullstackCodingNochange,
  'workflows/guidance/fullstack-qa-post-approval.md': mdworkflowsGuidanceFullstackQaPostApproval,
  'workflows/guidance/review-policy.md': mdworkflowsGuidanceReviewPolicy,
  'workflows/guidance/review-thread-approval-check.md':
    mdworkflowsGuidanceReviewThreadApprovalCheck,
  'workflows/guidance/review-thread-resolution.md': mdworkflowsGuidanceReviewThreadResolution,
  'workflows/guidance/reviewer-post-approval-blocker.md':
    mdworkflowsGuidanceReviewerPostApprovalBlocker,
  'workflows/guidance/reviewer-zero-findings-gate.md': mdworkflowsGuidanceReviewerZeroFindingsGate,
  'workflows/guidance/subscribe-pr-events.md': mdworkflowsGuidanceSubscribePrEvents,
  'workflows/research/research-prompt.md': mdworkflowsResearchResearchPrompt,
  'workflows/research/review-prompt.md': mdworkflowsResearchReviewPrompt,
  'workflows/review-only/review-prompt.md': mdworkflowsReviewOnlyReviewPrompt,
};

export const {
  LONG_HORIZON_SCHEDULING_GUARDRAIL,
  LONG_HORIZON_OWNER_REVIEW_CONTRACT,
  LH_TASK_MANAGER_INSTRUCTIONS,
  NON_DELEGATING_GENERAL_PROMPT,
  PRESET_CODER_PROMPT,
  PRESET_GENERAL_PROMPT,
  LEGACY_REVIEWER_PROMPT,
  PRESET_PLANNER_PROMPT,
  PRESET_RESEARCH_PROMPT,
  QA_SYSTEM_CONTRACT,
  REVIEWER_SYSTEM_CONTRACT,
  MERGE_SESSION_COMMAND_PROMPT,
  SUBAGENT_CODER_PROMPT,
  COORDINATOR_PROMPT,
  SUBAGENT_DEBUGGER_PROMPT,
  SUBAGENT_REVIEWER_PROMPT,
  SUBAGENT_TESTER_PROMPT,
  SUBAGENT_VCS_PROMPT,
  SUBAGENT_VERIFIER_PROMPT,
  GITHUB_ROUTER_SYSTEM_PROMPT,
  GITHUB_SECURITY_SYSTEM_PROMPT,
  POST_APPROVAL_COMPLETION_INSTRUCTIONS,
  PROMPT_TOO_LONG_CONTINUE_NAG,
  WORKFLOW_SELECTOR_INSTRUCTIONS,
  TITLE_GENERATION_PROMPT,
  SPACE_OPERATIONS_DOOR,
  CODER_ONLY_MERGE_INSTRUCTIONS,
  CODER_ONLY_PROMPT,
  CODER_EXTERNAL_GATE_BLOCK,
  CODER_OWNED_MERGE_INSTRUCTIONS,
  CODER_OWNED_MERGE_PROMPT,
  CODER_OWNED_QA_PROMPT,
  CODER_OWNED_QA_REVIEW_PROMPT,
  CODER_OWNED_REVIEW_PROMPT,
  CALL_ACTION_PREFERENCE_GUIDANCE,
  CALL_ACTION_PREFERENCE_GUIDANCE_PRE_OPERATION_NAMES,
  CODEX_REACTION_APPROVAL_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_CHECK_SEEDING,
  EXTERNAL_REVIEW_BOTS_GUIDANCE_PRE_TYPENAME,
  FULLSTACK_CODING_NOCHANGE_GUIDANCE,
  FULLSTACK_QA_POST_APPROVAL_PARAGRAPH,
  REVIEW_POLICY_GUIDANCE,
  REVIEW_THREAD_APPROVAL_CHECK_GUIDANCE,
  REVIEW_THREAD_RESOLUTION_GUIDANCE,
  REVIEWER_POST_APPROVAL_BLOCKER_PARAGRAPH,
  REVIEWER_ZERO_FINDINGS_GATE,
  CODER_OWNED_PR_SUBSCRIBE_GUIDANCE,
  RESEARCH_PROMPT,
  RESEARCH_REVIEW_PROMPT,
  REVIEW_ONLY_REVIEW_PROMPT,
} = buildPromptRegistry(registry);
