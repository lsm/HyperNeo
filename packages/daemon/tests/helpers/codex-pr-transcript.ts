export const SYNTHETIC_PR = 'https://github.com/synthetic/repo/pull/42';

export function syntheticCodexPrLines(repetitions = 32_000): string[] {
  return [
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text:
              'Tool documentation: attach_artifact ' +
              'pull_request '.repeat(repetitions) +
              'https://github.com/synthetic/repo/pull/not-a-number',
          },
        ],
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'custom_tool_call',
        call_id: 'synthetic-attach',
        input: `await tools.attach_artifact({artifact_type:"pull_request",url:"${SYNTHETIC_PR}"})`,
      },
    }),
  ];
}
