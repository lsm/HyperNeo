/// <reference path="./markdown.d.ts" />
import { buildPromptRegistry } from './loader.ts';
import mdagentsLongHorizonSchedulingGuardrail from './agents/long-horizon-scheduling-guardrail.md' with {
  type: 'text',
};
import mdagentsLongHorizonCoordinator from './agents/long-horizon/coordinator.md' with {
  type: 'text',
};
import mdagentsLongHorizonFamilyOpsChores from './agents/long-horizon/family-ops-chores.md' with {
  type: 'text',
};
import mdagentsLongHorizonMarketing from './agents/long-horizon/marketing.md' with { type: 'text' };
import mdagentsLongHorizonOwnerReviewContract from './agents/long-horizon/owner-review-contract.md' with {
  type: 'text',
};
import mdagentsLongHorizonProductQualityManager from './agents/long-horizon/product-quality-manager.md' with {
  type: 'text',
};
import mdagentsLongHorizonReleaseManager from './agents/long-horizon/release-manager.md' with {
  type: 'text',
};
import mdagentsLongHorizonResearch from './agents/long-horizon/research.md' with { type: 'text' };
import mdagentsLongHorizonSales from './agents/long-horizon/sales.md' with { type: 'text' };
import mdagentsLongHorizonSecurityAuditor from './agents/long-horizon/security-auditor.md' with {
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
import mdspaceChatAutonomy3 from './space-chat/autonomy-3.md' with { type: 'text' };
import mdspaceChatAutonomy4 from './space-chat/autonomy-4.md' with { type: 'text' };
import mdspaceChatAutonomy5 from './space-chat/autonomy-5.md' with { type: 'text' };
import mdspaceChatAutonomyLow from './space-chat/autonomy-low.md' with { type: 'text' };
import mdspaceChatCoordinationInvariants from './space-chat/coordination-invariants.md' with {
  type: 'text',
};
import mdspaceChatEscalationAct from './space-chat/escalation-act.md' with { type: 'text' };
import mdspaceChatEscalationAsk from './space-chat/escalation-ask.md' with { type: 'text' };
import mdspaceChatEventHandling from './space-chat/event-handling.md' with { type: 'text' };
import mdspaceChatIntro from './space-chat/intro.md' with { type: 'text' };
import mdspaceChatSubagents from './space-chat/subagents.md' with { type: 'text' };
import mdspaceChatWorkCreation from './space-chat/work-creation.md' with { type: 'text' };
import mdspaceChatWorkflowListingNote from './space-chat/workflow-listing-note.md' with {
  type: 'text',
};
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
  'agents/long-horizon/coordinator.md': mdagentsLongHorizonCoordinator,
  'agents/long-horizon/family-ops-chores.md': mdagentsLongHorizonFamilyOpsChores,
  'agents/long-horizon/marketing.md': mdagentsLongHorizonMarketing,
  'agents/long-horizon/owner-review-contract.md': mdagentsLongHorizonOwnerReviewContract,
  'agents/long-horizon/product-quality-manager.md': mdagentsLongHorizonProductQualityManager,
  'agents/long-horizon/release-manager.md': mdagentsLongHorizonReleaseManager,
  'agents/long-horizon/research.md': mdagentsLongHorizonResearch,
  'agents/long-horizon/sales.md': mdagentsLongHorizonSales,
  'agents/long-horizon/security-auditor.md': mdagentsLongHorizonSecurityAuditor,
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
  'space-chat/autonomy-3.md': mdspaceChatAutonomy3,
  'space-chat/autonomy-4.md': mdspaceChatAutonomy4,
  'space-chat/autonomy-5.md': mdspaceChatAutonomy5,
  'space-chat/autonomy-low.md': mdspaceChatAutonomyLow,
  'space-chat/coordination-invariants.md': mdspaceChatCoordinationInvariants,
  'space-chat/escalation-act.md': mdspaceChatEscalationAct,
  'space-chat/escalation-ask.md': mdspaceChatEscalationAsk,
  'space-chat/event-handling.md': mdspaceChatEventHandling,
  'space-chat/intro.md': mdspaceChatIntro,
  'space-chat/subagents.md': mdspaceChatSubagents,
  'space-chat/work-creation.md': mdspaceChatWorkCreation,
  'space-chat/workflow-listing-note.md': mdspaceChatWorkflowListingNote,
  'workflows/coder-only/merge-instructions.md': mdworkflowsCoderOnlyMergeInstructions,
  'workflows/coder-only/prompt.md': mdworkflowsCoderOnlyPrompt,
  'workflows/coder-owned/external-gate.md': mdworkflowsCoderOwnedExternalGate,
  'workflows/coder-owned/merge-instructions.md': mdworkflowsCoderOwnedMergeInstructions,
  'workflows/coder-owned/merge-prompt.md': mdworkflowsCoderOwnedMergePrompt,
  'workflows/coder-owned/qa-prompt.md': mdworkflowsCoderOwnedQaPrompt,
  'workflows/coder-owned/qa-review-prompt.md': mdworkflowsCoderOwnedQaReviewPrompt,
  'workflows/coder-owned/review-prompt.md': mdworkflowsCoderOwnedReviewPrompt,
  'workflows/guidance/codex-reaction-approval.md': mdworkflowsGuidanceCodexReactionApproval,
  'workflows/guidance/external-review-bots.md': mdworkflowsGuidanceExternalReviewBots,
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
  LH_COORDINATOR_INSTRUCTIONS,
  LH_FAMILY_OPS_CHORES_INSTRUCTIONS,
  LH_MARKETING_INSTRUCTIONS,
  LONG_HORIZON_OWNER_REVIEW_CONTRACT,
  LH_PRODUCT_QUALITY_MANAGER_INSTRUCTIONS,
  LH_RELEASE_MANAGER_INSTRUCTIONS,
  LH_RESEARCH_INSTRUCTIONS,
  LH_SALES_INSTRUCTIONS,
  LH_SECURITY_AUDITOR_INSTRUCTIONS,
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
  SPACE_CHAT_AUTONOMY_3,
  SPACE_CHAT_AUTONOMY_4,
  SPACE_CHAT_AUTONOMY_5,
  SPACE_CHAT_AUTONOMY_LOW,
  SPACE_CHAT_COORDINATION_INVARIANTS,
  SPACE_CHAT_ESCALATION_ACT,
  SPACE_CHAT_ESCALATION_ASK,
  SPACE_CHAT_EVENT_HANDLING,
  SPACE_CHAT_INTRO,
  SPACE_CHAT_SUBAGENTS,
  SPACE_CHAT_WORK_CREATION,
  SPACE_CHAT_WORKFLOW_LISTING_NOTE,
  CODER_ONLY_MERGE_INSTRUCTIONS,
  CODER_ONLY_PROMPT,
  CODER_EXTERNAL_GATE_BLOCK,
  CODER_OWNED_MERGE_INSTRUCTIONS,
  CODER_OWNED_MERGE_PROMPT,
  CODER_OWNED_QA_PROMPT,
  CODER_OWNED_QA_REVIEW_PROMPT,
  CODER_OWNED_REVIEW_PROMPT,
  CODEX_REACTION_APPROVAL_GUIDANCE,
  EXTERNAL_REVIEW_BOTS_GUIDANCE,
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
