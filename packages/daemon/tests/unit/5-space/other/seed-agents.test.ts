import { describe, expect, it } from 'bun:test';
import {
  getPresetAgentTemplates,
  PRESET_AGENT_TOOLS,
  SUB_SESSION_FEATURES,
} from '../../../../src/lib/space/agents/seed-agents';

describe('PRESET_AGENT_TOOLS export', () => {
  const EXPECTED_CODER_TOOLS: string[] = [];

  const EXPECTED_QA_TOOLS = [
    'Read',
    'Bash',
    'Grep',
    'Glob',
    'WebFetch',
    'WebSearch',
    'Skill',
    'ToolSearch',
  ];
  const EXPECTED_REVIEWER_TOOLS = [
    'Read',
    'Bash(gh pr view:*)',
    'Bash(gh pr diff:*)',
    'Bash(gh pr checks:*)',
    'Bash(gh api graphql:*)',
    'Bash(gh api repos:*)',
    'Bash(jq:*)',
    'Bash(mktemp:*)',
    'Bash(echo:*)',
    'Bash(cat:*)',
    'Bash(test:*)',
    'Bash(head:*)',
    'Bash(tr:*)',
    'Bash(base64:*)',
    'Bash(exit:*)',
    'Grep',
    'Glob',
    'WebFetch',
    'WebSearch',
    'Skill',
    'ToolSearch',
    'Task',
    'TaskOutput',
    'TaskStop',
    'CronCreate',
    'CronDelete',
    'CronList',
  ];

  it('has entries for all 6 preset roles', () => {
    expect(Object.keys(PRESET_AGENT_TOOLS).sort()).toEqual([
      'coder',
      'general',
      'planner',
      'qa',
      'research',
      'reviewer',
    ]);
  });

  it('coder role maps to empty permissive profile', () => {
    expect(PRESET_AGENT_TOOLS.coder).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('general role maps to GENERAL_TOOLS (empty permissive profile)', () => {
    expect(PRESET_AGENT_TOOLS.general).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('planner role maps to PLANNER_TOOLS (empty permissive profile)', () => {
    expect(PRESET_AGENT_TOOLS.planner).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('research role maps to RESEARCH_TOOLS (empty permissive profile)', () => {
    expect(PRESET_AGENT_TOOLS.research).toEqual(EXPECTED_CODER_TOOLS);
  });

  it('reviewer role maps to REVIEWER_TOOLS (read-only + scoped gh Bash + Task/* + Cron*, no bare Bash)', () => {
    expect(PRESET_AGENT_TOOLS.reviewer).toEqual(EXPECTED_REVIEWER_TOOLS);
  });

  it('qa role maps to QA_TOOLS', () => {
    expect(PRESET_AGENT_TOOLS.qa).toEqual(EXPECTED_QA_TOOLS);
  });
});

describe('SUB_SESSION_FEATURES export', () => {
  it('has exactly the expected feature flags', () => {
    expect(SUB_SESSION_FEATURES).toEqual({
      rewind: false,
      worktree: false,
      coordinator: false,
      archive: false,
      sessionInfo: false,
    });
  });

  it('all feature values are false', () => {
    for (const [, value] of Object.entries(SUB_SESSION_FEATURES)) {
      expect(value).toBe(false);
    }
  });
});

describe('getPresetAgentTemplates', () => {
  it('returns exactly 6 templates', () => {
    const templates = getPresetAgentTemplates();
    expect(templates).toHaveLength(6);
  });

  it('returns all expected agent names', () => {
    const templates = getPresetAgentTemplates();
    const names = templates.map((t) => t.name).sort();
    expect(names).toEqual(['Coder', 'General', 'Planner', 'QA', 'Research', 'Reviewer']);
  });

  it('each template has name, description, tools, and customPrompt', () => {
    const templates = getPresetAgentTemplates();
    for (const t of templates) {
      expect(typeof t.name).toBe('string');
      expect(t.name.length).toBeGreaterThan(0);
      expect(typeof t.description).toBe('string');
      expect(t.description.length).toBeGreaterThan(0);
      expect(Array.isArray(t.tools)).toBe(true);
      expect(typeof t.customPrompt).toBe('string');
      expect(t.customPrompt.length).toBeGreaterThan(0);
    }
  });

  it('returns cloned arrays — mutating tools does not affect globals', () => {
    const first = getPresetAgentTemplates();
    const coderTools = first.find((t) => t.name === 'Coder')!.tools;
    coderTools.push('FakeTool');

    const second = getPresetAgentTemplates();
    const coderTools2 = second.find((t) => t.name === 'Coder')!.tools;
    expect(coderTools2).not.toContain('FakeTool');
  });

  it('template tools match PRESET_AGENT_TOOLS', () => {
    const templates = getPresetAgentTemplates();
    for (const t of templates) {
      const roleKey = t.handle;
      expect(t.tools).toEqual(PRESET_AGENT_TOOLS[roleKey]);
    }
  });
});
