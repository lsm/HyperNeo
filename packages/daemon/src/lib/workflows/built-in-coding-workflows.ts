import {
  CODER_ONLY_MERGE_INSTRUCTIONS,
  CODER_ONLY_PROMPT,
  CODER_OWNED_MERGE_PROMPT,
  CODER_OWNED_QA_PROMPT,
  CODER_OWNED_QA_REVIEW_PROMPT,
  CODER_OWNED_REVIEW_PROMPT,
} from '@hyperneo/prompts';
import type { EventInterest, SpaceWorkflow } from '@hyperneo/shared';
import { workerTemplateKey } from '../agents/long-horizon-templates.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from './post-approval-merge-template.ts';

export const IMPLEMENTER_PR_EVENT_INTEREST: EventInterest = {
  topicFrom: { source: 'primaryLink', pattern: 'github/{owner}/{repo}/pull_request/{number}.*' },
  label: 'My PR events',
};

export const CODING_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Coding',
  handle: 'coding',
  description:
    'Stable coding workflow with a Coder ↔ Reviewer loop. The coder implements and owns the audited post-approval merge.',
  nodes: [
    {
      id: 'tpl-stable-coding-code',
      name: 'Coding',
      agents: [
        {
          agentId: '',
          templateKey: workerTemplateKey('swe'),
          name: 'coder',
          customPrompt: { value: CODER_OWNED_MERGE_PROMPT },
          eventInterests: [IMPLEMENTER_PR_EVENT_INTEREST],
        },
      ],
      postApproval: {
        targetAgent: 'coder',
        instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
        requirePrMerge: true,
      },
    },
    {
      id: 'tpl-stable-coding-review',
      name: 'Review',
      agents: [
        {
          agentId: '',
          templateKey: workerTemplateKey('reviewer'),
          name: 'reviewer',
          resetContextPerTurn: true,
          customPrompt: { value: CODER_OWNED_REVIEW_PROMPT },
        },
      ],
    },
  ],
  startNodeId: 'tpl-stable-coding-code',
  endNodeId: 'tpl-stable-coding-review',
  tags: ['coding'],
  createdAt: 0,
  updatedAt: 0,
  completionAutonomyLevel: 3,
  hooks: [
    {
      id: 'code-pr-ready',
      enabled: true,
      label: 'PR Ready',
      sourceNode: 'Coding',
      targetNode: 'Review',
      method: 'send_message',
      classification: 'validation',
      order: 0,
      validator: { kind: 'built_in', id: 'pr_ready' },
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
    },
    {
      id: 'review-posted',
      enabled: true,
      label: 'Review Posted',
      sourceNode: 'Review',
      targetNode: 'Coding',
      method: 'send_message',
      classification: 'validation',
      order: 0,
      validator: { kind: 'built_in', id: 'review_posted' },
      authorizedCallers: [{ sourceNode: 'Review' }],
    },
  ],
  channels: [
    {
      from: 'Coding',
      to: 'Review',
      label: 'Coding → Review',
    },
    {
      from: 'Review',
      to: 'Coding',
      maxCycles: 5,
      label: 'Review → Coding (changes requested)',
    },
  ],
};

export const CODING_WITH_QA_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Coding with QA',
  handle: 'coding-with-qa',
  description:
    'Stable Coder → Reviewer → QA workflow. The coder owns the audited post-approval merge after QA approval.',
  nodes: [
    {
      id: 'tpl-stable-qa-coding',
      name: 'Coding',
      agents: [
        {
          agentId: '',
          templateKey: workerTemplateKey('swe'),
          name: 'coder',
          customPrompt: { value: CODER_OWNED_MERGE_PROMPT },
          eventInterests: [IMPLEMENTER_PR_EVENT_INTEREST],
        },
      ],
      postApproval: {
        targetAgent: 'coder',
        instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
        requirePrMerge: true,
      },
    },
    {
      id: 'tpl-stable-qa-review',
      name: 'Review',
      agents: [
        {
          agentId: '',
          templateKey: workerTemplateKey('reviewer'),
          name: 'reviewer',
          customPrompt: { value: CODER_OWNED_QA_REVIEW_PROMPT },
        },
      ],
    },
    {
      id: 'tpl-stable-qa-qa',
      name: 'QA',
      agents: [
        {
          agentId: '',
          templateKey: workerTemplateKey('qa'),
          name: 'qa',
          customPrompt: { value: CODER_OWNED_QA_PROMPT },
        },
      ],
    },
  ],
  startNodeId: 'tpl-stable-qa-coding',
  endNodeId: 'tpl-stable-qa-qa',
  tags: ['fullstack', 'qa', 'browser-testing'],
  createdAt: 0,
  updatedAt: 0,
  completionAutonomyLevel: 3,
  layout: {
    'tpl-stable-qa-coding': { x: 80, y: 160 },
    'tpl-stable-qa-review': { x: 420, y: 80 },
    'tpl-stable-qa-qa': { x: 760, y: 160 },
  },
  channels: [
    {
      from: 'Coding',
      to: 'Review',
      label: 'Coding → Review',
    },
    {
      from: 'Review',
      to: 'QA',
      label: 'Review → QA',
    },
    {
      from: 'Review',
      to: 'Coding',
      maxCycles: 50,
      label: 'Review → Coding (feedback)',
    },
    {
      from: 'QA',
      to: 'Coding',
      maxCycles: 50,
      label: 'QA → Coding (issues found)',
    },
    {
      from: 'Coding',
      to: 'QA',
      maxCycles: 5,
      label: 'Coding → QA (post-approval merge blocker)',
    },
  ],
  hooks: [
    {
      id: 'fullstack-code-pr-ready',
      enabled: true,
      label: 'PR Ready',
      sourceNode: 'Coding',
      targetNode: 'Review',
      method: 'send_message',
      classification: 'validation',
      order: 0,
      validator: { kind: 'built_in', id: 'pr_ready' },
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
    },
    {
      id: 'stable-qa-coding-to-qa-post-approval',
      enabled: true,
      label: 'Post-Approval Only',
      sourceNode: 'Coding',
      targetNode: 'QA',
      method: 'send_message',
      classification: 'validation',
      order: 0,
      validator: { kind: 'built_in', id: 'post_approval_only' },
      authorizedCallers: [{ sourceNode: 'Coding', agentSlots: ['coder'] }],
    },
  ],
};

const CODER_ONLY_NODE = 'tpl-coder-only-code';

export const CODER_ONLY_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Coder-Only Workflow',
  handle: 'coder-only-workflow',
  description:
    'Single-coder workflow with no internal reviewer. Review is delegated to whichever external AI review bots are installed for the repository — the coder discovers them, waits for their clean verdicts on the current head, runs a final informal review, then requests human approval and merges post-approval.',
  nodes: [
    {
      id: CODER_ONLY_NODE,
      name: 'Coding',
      agents: [
        {
          agentId: '',
          templateKey: workerTemplateKey('swe'),
          name: 'coder',
          customPrompt: { value: CODER_ONLY_PROMPT },
          eventInterests: [IMPLEMENTER_PR_EVENT_INTEREST],
        },
      ],
      postApproval: {
        targetAgent: 'coder',
        instructions: CODER_ONLY_MERGE_INSTRUCTIONS,
        requirePrMerge: true,
      },
    },
  ],
  startNodeId: CODER_ONLY_NODE,
  endNodeId: CODER_ONLY_NODE,
  tags: ['coding', 'external-review', 'default'],
  createdAt: 0,
  updatedAt: 0,
  completionAutonomyLevel: 5,
};
