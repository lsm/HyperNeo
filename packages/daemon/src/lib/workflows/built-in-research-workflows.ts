import {
  RESEARCH_PROMPT,
  RESEARCH_REVIEW_PROMPT,
  REVIEW_ONLY_REVIEW_PROMPT,
} from '@hyperneo/prompts';
import type { SpaceWorkflow } from '@hyperneo/shared';
import { workerTemplateKey } from '../agents/long-horizon-templates.ts';
import { IMPLEMENTER_PR_EVENT_INTEREST } from './built-in-coding-workflows.ts';
import { CODER_OWNED_MERGE_INSTRUCTIONS } from './post-approval-merge-template.ts';

const RESEARCH_RESEARCH_NODE = 'tpl-research-research';
const RESEARCH_REVIEW_NODE = 'tpl-research-review';

const REVIEW_REVIEW_NODE = 'tpl-review-review';

export const RESEARCH_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Research Workflow',
  handle: 'research-workflow',
  description:
    'Iterative research workflow with gated PR verification. Research agent investigates and opens a PR; Reviewer evaluates findings and requests revisions if needed.',
  nodes: [
    {
      id: RESEARCH_RESEARCH_NODE,
      name: 'Research',
      agents: [
        {
          agentId: '',
          templateKey: workerTemplateKey('research'),
          name: 'research',
          eventInterests: [IMPLEMENTER_PR_EVENT_INTEREST],
          customPrompt: { value: RESEARCH_PROMPT },
        },
      ],
      postApproval: {
        targetAgent: 'research',
        instructions: CODER_OWNED_MERGE_INSTRUCTIONS,
        requirePrMerge: true,
      },
    },
    {
      id: RESEARCH_REVIEW_NODE,
      name: 'Review',
      agents: [
        {
          agentId: '',
          templateKey: workerTemplateKey('reviewer'),
          name: 'reviewer',
          customPrompt: { value: RESEARCH_REVIEW_PROMPT },
        },
      ],
    },
  ],
  startNodeId: RESEARCH_RESEARCH_NODE,
  endNodeId: RESEARCH_REVIEW_NODE,
  tags: ['research'],
  createdAt: 0,
  updatedAt: 0,
  completionAutonomyLevel: 2,
  hooks: [
    {
      id: 'research-pr-ready',
      enabled: true,
      label: 'PR Ready',
      sourceNode: 'Research',
      targetNode: 'Review',
      method: 'send_message',
      classification: 'validation',
      order: 0,
      validator: { kind: 'built_in', id: 'pr_ready' },
      authorizedCallers: [{ sourceNode: 'Research', agentSlots: ['research'] }],
    },
  ],
  channels: [
    {
      from: 'Research',
      to: 'Review',
      label: 'Research → Review',
    },
    {
      from: 'Review',
      to: 'Research',
      maxCycles: 5,
      label: 'Review → Research (more research needed)',
    },
  ],
};
export const REVIEW_ONLY_WORKFLOW: SpaceWorkflow = {
  id: '',
  spaceId: '',
  name: 'Review-Only Workflow',
  handle: 'review-only-workflow',
  description:
    'Single-node review workflow with no planning phase. Reviewer evaluates directly; the run completes when done.',
  nodes: [
    {
      id: REVIEW_REVIEW_NODE,
      name: 'Review',
      agents: [
        {
          agentId: '',
          templateKey: workerTemplateKey('reviewer'),
          name: 'reviewer',
          customPrompt: { value: REVIEW_ONLY_REVIEW_PROMPT },
        },
      ],
    },
  ],
  startNodeId: REVIEW_REVIEW_NODE,
  endNodeId: REVIEW_REVIEW_NODE,
  tags: ['review'],
  createdAt: 0,
  updatedAt: 0,
  completionAutonomyLevel: 2,
};
