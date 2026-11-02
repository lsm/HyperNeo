import type { SessionEvent } from '@github/copilot-sdk';
import { readCopilotHistory } from './copilot-history.ts';
import { projectCopilotEvent } from './copilot-worker.ts';
import { recentWorkInputs, workInput, TURN_REPLIES } from './work-messages.ts';
import type { WorkInput, WorkDetail } from './types.ts';

type State = Parameters<typeof projectCopilotEvent>[0];

export function readCopilotObservations(
  file: string,
  id: string,
  inputs: State['inputs'],
  known: (inputId: string) => boolean,
  since?: number
) {
  let state: State = { status: 'queued', inputs: {} };
  readCopilotHistory(file, id, undefined, 10, 10, undefined, undefined, (event) => {
    const inputId = event.type === 'user.message' ? event.data.messageId : undefined;
    if (
      !event.agentId &&
      inputId &&
      !Object.hasOwn(state.inputs, inputId) &&
      ['done', 'failed', 'stopped'].includes(state.status)
    )
      state.status = 'queued';
    if (!event.agentId && inputId && !Object.hasOwn(state.inputs, inputId) && known(inputId))
      state.inputs[inputId] = {
        state: 'pending',
        replyReport: '',
        replyAvailability: 'incomplete',
        human: false,
      };
    state = projectCopilotEvent(state, {
      ...event,
      id: event.id ?? event.timestamp,
      parentId: null,
    } as SessionEvent);
    const retained = Object.keys(state.inputs);
    if (retained.length > 64) delete state.inputs[retained[0]];
  });
  const recentInputs: WorkInput[] = [];
  const turnEnds: NonNullable<WorkDetail['turnEnds']> = [];
  const observations = { ...state.inputs };
  for (const [inputId, input] of Object.entries(inputs))
    observations[inputId] = { ...observations[inputId], ...input };
  for (const [inputId, input] of Object.entries(observations)) {
    if (input.state !== 'observed' || input.at === undefined || !Number.isFinite(input.at))
      continue;
    const entry = workInput(input.at, input.text ?? '', input.human, inputId);
    if (entry) recentInputs.push(entry);
    if (since !== undefined && input.endedAt !== undefined && input.endedAt > since)
      turnEnds.push({
        id: inputId,
        startedAt: input.at,
        at: input.endedAt,
        message: input.replyReport,
      });
  }
  recentInputs.sort((a, b) => a.at - b.at);
  const ends = turnEnds.sort((a, b) => a.at - b.at).slice(-TURN_REPLIES);
  const ended = new Set(ends.map((turn) => turn.id));
  const selected = new Set(
    since === undefined
      ? recentWorkInputs(recentInputs)
      : recentWorkInputs(
          [
            ...recentInputs.filter((input) => ended.has(input.inputId!)),
            ...recentInputs.filter((input) => !ended.has(input.inputId!)).reverse(),
          ],
          since
        )
  );
  return {
    recentInputs: recentInputs.filter((input) => selected.has(input)),
    turnEnds: ends,
  };
}
