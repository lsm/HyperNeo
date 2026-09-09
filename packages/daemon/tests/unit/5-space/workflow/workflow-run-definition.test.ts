import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  encodeWorkflowRunDefinition,
  hashWorkflowRunDefinitionPayload,
  type WorkflowRunDefinitionV1,
  type WorkflowRunExecutableV1,
} from '../../../../src/lib/space/workflows/workflow-run-definition.ts';

function executableDefinition(): WorkflowRunExecutableV1 {
  const prompt = 'Implement the requested change';
  return {
    schemaVersion: 1,
    kind: 'executable',
    provenance: {
      workflowRunId: 'run-1',
      spaceId: 'space-1',
      sourceWorkflowId: 'workflow-1',
      workers: [{ nodeId: 'code', workerName: 'coder', sourceTemplateKey: 'worker.swe' }],
    },
    space: {
      backgroundContext: 'Product context',
      instructions: 'Standing rules',
      taskTimeoutMs: null,
      autonomyLevel: 3,
    },
    workflow: {
      name: 'Coding',
      handle: 'coding',
      description: 'Implement a change',
      instructions: 'Follow the graph',
      nodes: [
        {
          id: 'code',
          name: 'Code',
          workers: [
            {
              name: 'coder',
              handle: 'swe',
              displayName: 'Coder',
              description: 'Writes code',
              prompt: {
                value: prompt,
                source: 'space_agent_custom_prompt',
                hash: createHash('sha256').update(prompt).digest('hex'),
              },
              modelPolicy: {
                kind: 'fixed',
                model: 'claude-sonnet-5',
                provider: 'anthropic',
              },
              thinkingLevel: 'think8k',
              permissionMode: 'bypassPermissions',
              settingSources: ['project'],
              allowedTools: ['Read'],
              disallowedTools: ['Write'],
              features: {
                rewind: false,
                worktree: false,
                coordinator: false,
                archive: false,
                sessionInfo: false,
              },
              agents: {
                'general-purpose': {
                  description: 'Investigate a focused question directly.',
                  tools: ['Read'],
                  disallowedTools: ['Agent'],
                  prompt: 'Complete the assigned work without delegation.',
                  model: 'inherit',
                },
              },
              disabledSkillIds: [],
              extraMcpServers: {},
              eventInterests: [],
              noProgressTimeoutMs: 900_000,
              toolGuards: [],
              resetContextPerTurn: true,
            },
          ],
          transitions: [],
        },
      ],
      startNodeId: 'code',
      endNodeId: 'code',
      channels: [],
      hooks: [],
      completionAutonomyLevel: 3,
    },
  };
}

describe('workflow run definition v1 encoding', () => {
  test('encodes equal values to identical bytes regardless of object key insertion order', () => {
    const value = executableDefinition();
    const reordered = JSON.parse(JSON.stringify(value)) as WorkflowRunExecutableV1;
    reordered.provenance = {
      workers: reordered.provenance.workers,
      sourceWorkflowId: reordered.provenance.sourceWorkflowId,
      spaceId: reordered.provenance.spaceId,
      workflowRunId: reordered.provenance.workflowRunId,
    };

    expect(encodeWorkflowRunDefinition(reordered)).toEqual(encodeWorkflowRunDefinition(value));
  });

  test('omits explicit undefined object properties without producing invalid JSON', () => {
    const value = executableDefinition();
    value.workflow.handle = undefined as never;
    const encoded = encodeWorkflowRunDefinition(value);

    expect(() => JSON.parse(encoded.payload)).not.toThrow();
    expect(JSON.parse(encoded.payload).workflow).not.toHaveProperty('handle');
  });

  test('hashes the exact UTF-8 payload bytes', () => {
    const encoded = encodeWorkflowRunDefinition(executableDefinition());

    expect(encoded.schemaVersion).toBe(1);
    expect(encoded.hash).toBe(
      createHash('sha256').update(Buffer.from(encoded.payload, 'utf8')).digest('hex')
    );
    expect(hashWorkflowRunDefinitionPayload(`${encoded.payload} `)).not.toBe(encoded.hash);
  });

  test('encodes explicit terminal history-only definitions', () => {
    const value: WorkflowRunDefinitionV1 = {
      schemaVersion: 1,
      kind: 'history_only',
      provenance: {
        workflowRunId: 'run-2',
        spaceId: 'space-1',
        sourceWorkflowId: 'workflow-missing',
        workers: [],
      },
      reason: 'source_unavailable',
    };

    expect(JSON.parse(encodeWorkflowRunDefinition(value).payload)).toEqual(value);
  });
});
