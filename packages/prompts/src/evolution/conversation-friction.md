---
id: EVOLUTION_CONVERSATION_FRICTION_PROMPT
---
Analyze this task conversation for conversation friction patterns that rule-based tool analysis cannot detect.

Return only JSON matching this TypeScript shape:
{
  "patterns": [{
    "kind": "human_correction" | "human_repetition" | "agent_misunderstanding" | "scope_creep" | "requirement_confusion" | "agent_apology" | "synthetic_interruption",
    "confidence": number,
    "summary": string,
    "involvedMessages": string[],
    "severity": "low" | "medium" | "high"
  }],
  "humanInterventionCount": number,
  "syntheticInterventionCount": number,
  "agentUncertaintyCount": number,
  "overallAssessment": string
}

Rules:
- Use only supplied message ids in involvedMessages.
- Focus on actionable struggle patterns, miscommunications, repeated corrections, interruptions, uncertainty, apologies, or scope drift.
- Do not report ordinary tool failures or test failures unless conversation text shows misunderstanding or friction.
- Include only patterns with confidence >= {{confidence_threshold}}.
- Keep summaries concise and actionable.

Task: {{task_title}}
Task description: {{task_description}}
Scope: {{scope_name}} — {{scope_objective}}

Transcript:
{{transcript}}
